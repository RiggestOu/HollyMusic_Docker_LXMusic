'use strict'

/**
 * LX 音源运行器
 *
 * 负责：加载脚本 → 在沙箱内执行 → 等待 send('inited') 握手 → 保存能力表
 *       → 按 (source, action) 把请求分发给脚本注册的 request 处理器
 *
 * 与 LX 桌面端的差异（有意为之，用于解决「部分歌曲无法播放」）：
 *   桌面端会用 supportActions / supportQualitys 白名单过滤脚本声明的能力，
 *   只放行 musicUrl（lyric/pic 仅 local）。本实现直接采信脚本声明，
 *   因此 lyric / pic / musicSearch 等扩展动作也能正常工作。
 */

const { createSandbox, API_VERSION } = require('./sandbox')
const httpClient = require('./http')

const INIT_TIMEOUT = 5000
const INIT_POLL = 50
const CALL_TIMEOUT = 25000

function parseScriptInfo(script) {
  const match = /^\/\*[\S|\s]+?\*\//.exec(String(script || ''))
  const info = { name: '', description: '', version: '', author: '', homepage: '' }
  if (!match) return info
  const rxp = /^\s?\*?\s?@(\w+)\s(.+)$/
  for (const line of match[0].split(/\r?\n/)) {
    const m = rxp.exec(line)
    if (m && Object.prototype.hasOwnProperty.call(info, m[1])) {
      info[m[1]] = m[2].trim().slice(0, 1024)
    }
  }
  return info
}

class LXRunner {
  /**
   * @param {object} opts
   * @param {string} opts.id      音源 id
   * @param {string} opts.script  脚本源码
   * @param {function} [opts.log]
   */
  constructor(opts) {
    const o = opts || {}
    this.id = o.id
    this.script = String(o.script || '')
    this.scriptInfo = { ...parseScriptInfo(this.script), rawScript: this.script }
    this.log = typeof o.log === 'function' ? o.log : () => {}
    this.sandbox = null
    this.sources = {}
    this.ready = false
    this.lastError = null
    this.initedAt = 0
  }

  /** 加载并初始化 */
  async load() {
    this.dispose()

    const sb = createSandbox({
      scriptInfo: this.scriptInfo,
      log: this.log,
      requestImpl: (url, options, callback) => {
        // 沙箱侧 resp.raw 用宿主 Buffer（与 LX preload 行为一致）
        return httpClient.request(url, options, callback)
      },
    })
    this.sandbox = sb

    try {
      sb.run(this.script)
    } catch (e) {
      this.lastError = e
      throw new Error('脚本执行失败: ' + (e && e.message ? e.message : String(e)))
    }

    // 等待 send('inited')
    const deadline = Date.now() + INIT_TIMEOUT
    while (!sb.state.inited && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, INIT_POLL))
    }

    if (!sb.state.inited) {
      this.lastError = new Error('初始化超时（脚本未调用 send(inited)）')
      throw this.lastError
    }

    const info = sb.state.sourceInfo || {}
    this.sources = info.sources && typeof info.sources === 'object' ? info.sources : {}
    this.openDevTools = info.openDevTools === true
    this.ready = true
    this.initedAt = Date.now()

    if (!sb.state.requestHandler) {
      this.lastError = new Error('脚本未注册 request 事件处理器')
      this.ready = false
      throw this.lastError
    }

    return this.getMeta()
  }

  getMeta() {
    const platforms = {}
    for (const [source, cfg] of Object.entries(this.sources)) {
      platforms[source] = {
        name: (cfg && cfg.name) || source,
        type: (cfg && cfg.type) || 'music',
        actions: Array.isArray(cfg && cfg.actions) ? cfg.actions : [],
        qualitys: Array.isArray(cfg && cfg.qualitys) ? cfg.qualitys : [],
      }
    }
    return {
      id: this.id,
      name: this.scriptInfo.name || this.id,
      description: this.scriptInfo.description,
      version: this.scriptInfo.version,
      author: this.scriptInfo.author,
      apiVersion: API_VERSION,
      ready: this.ready,
      error: this.lastError ? String(this.lastError.message || this.lastError) : null,
      platforms,
    }
  }

  /** 该音源是否声明支持某平台 */
  supports(source) {
    return !!this.sources[source]
  }

  /** 该音源在平台上是否声明支持某动作（search 与 musicSearch 互通） */
  supportsAction(source, action) {
    const cfg = this.sources[source]
    if (!cfg) return false
    const list = Array.isArray(cfg.actions) ? cfg.actions : []
    if (!list.length) return true // 未声明则宽松放行
    const aliases = action === 'search' ? ['search', 'musicSearch'] : [action]
    return aliases.some((a) => list.includes(a))
  }

  /** 该音源在平台上声明的音质列表 */
  qualitysOf(source) {
    const cfg = this.sources[source]
    return Array.isArray(cfg && cfg.qualitys) ? cfg.qualitys.slice() : []
  }

  /** 平台展示名 */
  platformName(source) {
    const cfg = this.sources[source]
    return (cfg && cfg.name) || source
  }

  /**
   * 分发调用
   * @param {string} source kw/kg/tx/wy/mg/...
   * @param {string} action musicUrl | musicSearch | lyric | pic
   * @param {object} info   传给脚本的参数（musicUrl 用 {type, musicInfo}）
   */
  async call(source, action, info) {
    if (!this.ready || !this.sandbox) throw new Error('音源未就绪')
    const handler = this.sandbox.state.requestHandler
    if (typeof handler !== 'function') throw new Error('脚本未注册 request 处理器')
    if (!this.supports(source)) throw new Error('音源未提供平台: ' + source)
    if (!this.supportsAction(source, action)) {
      throw new Error('音源 ' + source + ' 不支持动作: ' + action)
    }

    const payload = { source, action, info: info || {} }

    let timer = null
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('音源响应超时')), CALL_TIMEOUT)
    })

    try {
      const result = await Promise.race([Promise.resolve(handler(payload)), timeout])
      return this.sandbox.toHostData(result)
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** 取播放地址 */
  async getMusicUrl(source, musicInfo, quality) {
    const url = await this.call(source, 'musicUrl', {
      type: quality,
      musicInfo,
    })
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      // 部分音源返回 {url} 结构
      if (url && typeof url.url === 'string' && /^https?:\/\//i.test(url.url)) return url.url
      throw new Error('音源返回的播放地址无效')
    }
    return url
  }

  /** 搜索（脚本提供 musicSearch 时使用） */
  async search(source, { keyword, page = 1, pagesize = 30 }) {
    const res = await this.call(source, 'musicSearch', {
      keyword,
      page,
      pagesize,
      pageSize: pagesize,
    })
    let list = []
    let isEnd = true
    let total = 0
    if (Array.isArray(res)) {
      list = res
      isEnd = res.length < pagesize
      total = res.length
    } else if (res && typeof res === 'object') {
      list = Array.isArray(res.list) ? res.list : []
      isEnd = res.isEnd === undefined ? list.length < pagesize : !!res.isEnd
      total = Number(res.total) || list.length
    }
    return { list, isEnd, total }
  }

  /** 歌词 */
  async getLyric(source, musicInfo) {
    const res = await this.call(source, 'lyric', { musicInfo })
    if (typeof res === 'string') return { lyric: res, tlyric: null }
    return res || null
  }

  /** 封面 */
  async getPic(source, musicInfo) {
    const res = await this.call(source, 'pic', { musicInfo })
    if (typeof res === 'string') return res
    if (res && typeof res.url === 'string') return res.url
    return null
  }

  dispose() {
    if (this.sandbox) {
      try {
        this.sandbox.dispose()
      } catch (_) {}
      this.sandbox = null
    }
    this.ready = false
  }
}

module.exports = { LXRunner, parseScriptInfo }
