'use strict'

/**
 * LX Music 自定义音源沙箱
 *
 * 对齐 lx-music-desktop 的 userApi 窗口行为：
 *   - 脚本运行在独立 vm 上下文中，看不到 process / require / Buffer / module
 *   - 只暴露 lx API（EVENT_NAMES / version / env / currentScriptInfo /
 *     request / on / send / utils.crypto / utils.buffer / utils.zlib）
 *
 * 为什么必须用 vm：
 *   部分音源带反调试自毁代码（会调用 process.kill(process.pid)），
 *   直接在主进程执行会杀死服务；vm 上下文中没有 process，自毁代码成为空操作。
 */

const vm = require('vm')
const nodeCrypto = require('crypto')
const nodeZlib = require('zlib')

const API_VERSION = '2.12.2'
const SYNC_TIMEOUT = 10000

const EVENT_NAMES = { request: 'request', inited: 'inited', updateAlert: 'updateAlert' }

/** 在沙箱域内组装 lx 对象，保证跨域类型（Uint8Array / Promise）正确 */
const LX_SETUP = `
(function () {
  var H = globalThis.__HOST__;
  var EVENT_NAMES = { request: 'request', inited: 'inited', updateAlert: 'updateAlert' };

  globalThis.__mkU8 = function (len) { return new Uint8Array(len); };

  var utils = {
    crypto: {
      aesEncrypt: function (buffer, mode, key, iv) { return H.aesEncrypt(buffer, mode, key, iv); },
      rsaEncrypt: function (buffer, key) { return H.rsaEncrypt(buffer, key); },
      randomBytes: function (size) { return H.randomBytes(size); },
      md5: function (str) { return H.md5(str); }
    },
    buffer: {
      from: function () { return H.bufferFrom.apply(null, arguments); },
      bufToString: function (buf, format) { return H.bufToString(buf, format); }
    },
    zlib: {
      inflate: function (buf) { return H.inflate(buf); },
      deflate: function (data) { return H.deflate(data); }
    }
  };

  globalThis.lx = {
    EVENT_NAMES: EVENT_NAMES,
    version: H.apiVersion,
    env: 'desktop',
    currentScriptInfo: H.scriptInfo,
    request: function (url, options, callback) { return H.request(url, options, callback); },
    on: function (eventName, handler) { return H.on(eventName, handler); },
    send: function (eventName, data) { return H.send(eventName, data); },
    utils: utils
  };

  globalThis.self = globalThis;
  globalThis.window = globalThis;
})();
`

/**
 * @param {object} opts
 * @param {object}   opts.scriptInfo  {name,description,version,author,homepage,rawScript}
 * @param {function} opts.requestImpl (url, options, callback) => { abort, promise }
 * @param {function} opts.log         (...args) => void
 */
function createSandbox(opts) {
  const options = opts || {}
  const log = typeof options.log === 'function' ? options.log : () => {}
  const scriptInfo = options.scriptInfo || {}
  const requestImpl =
    typeof options.requestImpl === 'function'
      ? options.requestImpl
      : () => ({ abort() {}, promise: Promise.reject(new Error('request 未实现')) })

  const state = {
    inited: false,
    sourceInfo: null,
    requestHandler: null,
    updateAlert: null,
    disposed: false,
  }

  const context = vm.createContext(Object.create(null), {
    name: 'lx-source',
    codeGeneration: { strings: true, wasm: false },
  })

  const timers = new Set()

  // ---------- 注入宿主能力 ----------
  // 完整 console 垫片：真实音源会调用 console.group / groupEnd / assert /
  // count / time 等方法，缺一个就会抛 "xxx is not a function" 导致播放失败。
  // 这里内置全部标准方法，并用 Proxy 兜底任意未列出的方法名。
  const CONSOLE_PASSTHROUGH = new Set(['log', 'info', 'warn', 'error', 'debug', 'trace'])
  const consoleBase = {}
  for (const m of [
    'log', 'info', 'warn', 'error', 'debug', 'trace', 'table', 'dir', 'dirxml',
    'group', 'groupCollapsed', 'groupEnd', 'assert', 'count', 'countReset',
    'time', 'timeEnd', 'timeLog', 'timeStamp', 'profile', 'profileEnd', 'clear',
  ]) {
    consoleBase[m] = (...a) => {
      if (CONSOLE_PASSTHROUGH.has(m) && m !== 'debug' && m !== 'trace') {
        log('[source:' + m + ']', ...a)
      }
    }
  }
  consoleBase.memory = {}
  context.console = new Proxy(consoleBase, {
    get(target, prop) {
      if (prop in target) return target[prop]
      return () => {} // 任意未知 console 方法一律空实现
    },
  })

  // 部分音源会读取 navigator / location 做 UA / 域名判断
  context.navigator = {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
    platform: 'Win32',
    language: 'zh-CN',
    languages: ['zh-CN', 'zh'],
  }
  context.location = {
    href: 'https://music.local/',
    origin: 'https://music.local',
    protocol: 'https:',
    host: 'music.local',
    hostname: 'music.local',
    pathname: '/',
    search: '',
    hash: '',
  }

  context.setTimeout = (fn, ms, ...args) => {
    const t = setTimeout(() => {
      timers.delete(t)
      try {
        fn(...args)
      } catch (e) {
        log('[source:timer]', e && e.message)
      }
    }, ms)
    timers.add(t)
    return t
  }
  context.clearTimeout = (t) => {
    timers.delete(t)
    clearTimeout(t)
  }
  context.setInterval = (fn, ms, ...args) => {
    const t = setInterval(() => {
      try {
        fn(...args)
      } catch (e) {
        log('[source:timer]', e && e.message)
      }
    }, ms)
    timers.add(t)
    return t
  }
  context.clearInterval = (t) => {
    timers.delete(t)
    clearInterval(t)
  }
  context.queueMicrotask = queueMicrotask

  // 浏览器风格工具（音源常用）
  context.TextEncoder = TextEncoder
  context.TextDecoder = TextDecoder
  context.URL = URL
  context.URLSearchParams = URLSearchParams
  context.atob = (s) => Buffer.from(String(s), 'base64').toString('binary')
  context.btoa = (s) => Buffer.from(String(s), 'binary').toString('base64')
  context.fetch = (...args) => fetch(...args)
  context.crypto = nodeCrypto.webcrypto

  // ---------- 跨域值转换 ----------
  const toSandboxBytes = (buf) => {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || [])
    const u8 = context.__mkU8(b.length)
    for (let i = 0; i < b.length; i++) u8[i] = b[i]
    return u8
  }

  const fromSandboxBytes = (value) => {
    if (value == null) return Buffer.alloc(0)
    if (typeof value === 'string') return Buffer.from(value, 'utf8')
    if (Buffer.isBuffer(value)) return value
    if (ArrayBuffer.isView(value)) {
      return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
    }
    if (typeof value.length === 'number') return Buffer.from(Array.prototype.slice.call(value))
    return Buffer.from(String(value), 'utf8')
  }

  const needBytes = (value, name) => {
    if (value == null) throw new Error(name + ' 缺少参数')
    return fromSandboxBytes(value)
  }

  const toHostData = (value) => {
    if (value == null) return value
    const t = typeof value
    if (t === 'string' || t === 'number' || t === 'boolean') return value
    try {
      return structuredClone(value)
    } catch (_) {
      try {
        return JSON.parse(JSON.stringify(value))
      } catch (__) {
        return value
      }
    }
  }

  // ---------- 宿主 API ----------
  const host = {
    apiVersion: API_VERSION,
    scriptInfo: {
      name: scriptInfo.name || '',
      description: scriptInfo.description || '',
      version: scriptInfo.version || '',
      author: scriptInfo.author || '',
      homepage: scriptInfo.homepage || '',
      rawScript: scriptInfo.rawScript || '',
    },

    /** 对齐 LX：request(url, options, callback) → 取消函数（同时可 await） */
    request: (url, reqOptions, callback) => {
      const impl = toHostData(reqOptions) || {}
      const cb = typeof callback === 'function' ? callback : null
      const req = requestImpl(String(url), impl, (err, resp, body) => {
        if (!cb) return
        try {
          cb(err || null, resp || null, body === undefined ? null : body)
        } catch (e) {
          log('[source:callback]', e && e.message)
        }
      })
      // 关键：音源常以回调风格调用且不消费返回的 promise，
      // 若不挂兜底 catch，网络失败会变成 unhandledRejection 直接崩掉进程。
      req.promise.catch(() => {})
      const abort = () => {
        try {
          req && req.abort && req.abort()
        } catch (_) {}
      }
      // 兼容 `await lx.request(url, opts)` 写法
      abort.then = (res, rej) => req.promise.then((r) => res(r.resp), rej)
      abort.catch = (rej) => req.promise.catch(rej)
      return abort
    },

    on: (eventName, handler) => {
      const name = String(eventName)
      if (!Object.values(EVENT_NAMES).includes(name)) {
        return Promise.reject(new Error('不支持的事件: ' + name))
      }
      if (name === 'request') {
        state.requestHandler = handler
        log('[source] 已注册 request 处理器')
      }
      return Promise.resolve()
    },

    send: (eventName, data) => {
      const name = String(eventName)
      if (!Object.values(EVENT_NAMES).includes(name)) {
        return Promise.reject(new Error('不支持的事件: ' + name))
      }
      if (name === 'inited') {
        if (state.inited) return Promise.reject(new Error('脚本已经初始化'))
        state.inited = true
        state.sourceInfo = toHostData(data) || {}
        log('[source] 初始化成功')
        return Promise.resolve()
      }
      if (name === 'updateAlert') {
        const d = toHostData(data) || {}
        if (typeof state.updateAlert === 'function') {
          try {
            state.updateAlert(d)
          } catch (_) {}
        }
        return Promise.resolve()
      }
      return Promise.resolve()
    },

    aesEncrypt: (buffer, mode, key, iv) => {
      const cipher = nodeCrypto.createCipheriv(
        String(mode),
        needBytes(key, 'key'),
        iv == null ? null : needBytes(iv, 'iv')
      )
      return toSandboxBytes(Buffer.concat([cipher.update(needBytes(buffer, 'buffer')), cipher.final()]))
    },

    rsaEncrypt: (buffer, key) => {
      const buf = needBytes(buffer, 'buffer')
      if (buf.length > 128) throw new Error('rsaEncrypt 数据超过 128 字节')
      const padded = Buffer.concat([Buffer.alloc(128 - buf.length), buf])
      return toSandboxBytes(
        nodeCrypto.publicEncrypt(
          { key: String(key), padding: nodeCrypto.constants.RSA_NO_PADDING },
          padded
        )
      )
    },

    randomBytes: (size) => toSandboxBytes(nodeCrypto.randomBytes(Number(size) || 0)),

    md5: (str) => nodeCrypto.createHash('md5').update(String(str)).digest('hex'),

    bufferFrom: function () {
      const first = arguments[0]
      if (typeof first === 'string') {
        return toSandboxBytes(
          Buffer.from(first, typeof arguments[1] === 'string' ? arguments[1] : 'utf8')
        )
      }
      return toSandboxBytes(fromSandboxBytes(first))
    },

    bufToString: (buf, format) => fromSandboxBytes(buf).toString(String(format || 'utf8')),

    inflate: (buf) =>
      new Promise((resolve, reject) => {
        nodeZlib.inflate(fromSandboxBytes(buf), (err, data) => {
          if (err) reject(new Error(err.message))
          else resolve(toSandboxBytes(data))
        })
      }),

    deflate: (data) =>
      new Promise((resolve, reject) => {
        nodeZlib.deflate(fromSandboxBytes(data), (err, buf) => {
          if (err) reject(new Error(err.message))
          else resolve(toSandboxBytes(buf))
        })
      }),
  }

  context.__HOST__ = host
  vm.runInContext(LX_SETUP, context, { filename: 'lx-api.js' })

  return {
    state,
    toHostData,
    /** 执行音源脚本（同步部分受 timeout 保护；异步初始化由 runner 轮询等待） */
    run(scriptCode) {
      vm.runInContext(String(scriptCode), context, {
        filename: 'custom-source.js',
        timeout: SYNC_TIMEOUT,
      })
    },
    dispose() {
      state.disposed = true
      for (const t of timers) {
        try {
          clearTimeout(t)
          clearInterval(t)
        } catch (_) {}
      }
      timers.clear()
      state.requestHandler = null
    },
  }
}

module.exports = { createSandbox, API_VERSION, EVENT_NAMES }
