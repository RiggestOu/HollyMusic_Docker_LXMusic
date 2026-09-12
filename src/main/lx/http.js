'use strict'

/**
 * 轻量 HTTP 客户端（零依赖，基于 node:http / node:https）
 *
 * 用途：
 *   1. 实现 LX 音源沙箱的 lx.request(url, options, callback)
 *   2. 音频/封面代理转发
 *
 * 设计要点：
 *   - 对齐 needle 的行为：resp.body 在能解析 JSON 时给对象，否则给字符串
 *   - 自动 gzip/deflate/br 解压
 *   - 支持 form（x-www-form-urlencoded）与 formData（multipart 由调用方给字符串）
 */

const http = require('http')
const https = require('https')
const zlib = require('zlib')
const { URL } = require('url')

const DEFAULT_TIMEOUT = 15000
const MAX_REDIRECTS = 5

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36'

function isHttpsUrl(url) {
  return /^https:/i.test(String(url))
}

/**
 * 规范化 headers（补齐默认 UA）
 */
function normalizeHeaders(headers) {
  const out = {}
  if (headers && typeof headers === 'object') {
    for (const [k, v] of Object.entries(headers)) {
      if (v === undefined || v === null) continue
      out[k] = String(v)
    }
  }
  const hasUA = Object.keys(out).some((k) => k.toLowerCase() === 'user-agent')
  if (!hasUA) out['User-Agent'] = UA
  return out
}

function encodeForm(form) {
  if (typeof form === 'string') return form
  return Object.entries(form || {})
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v == null ? '' : String(v)))
    .join('&')
}

function decodeBody(rawBuffer, encoding) {
  const enc = String(encoding || '').toLowerCase()
  try {
    if (enc.includes('br')) return zlib.brotliDecompressSync(rawBuffer)
    if (enc.includes('gzip')) return zlib.gunzipSync(rawBuffer)
    if (enc.includes('deflate')) return zlib.inflateSync(rawBuffer)
  } catch (_) {
    /* 解压失败则按原文处理 */
  }
  return rawBuffer
}

/**
 * 发起请求（回调风格，兼容 needle）
 *
 * @param {string} url
 * @param {object} options { method, headers, body, form, formData, timeout, redirect }
 * @param {(err: Error|null, resp?: object, body?: any) => void} [callback]
 * @returns {{ abort: () => void, promise: Promise<object> }}
 */
function request(url, options, callback) {
  const opts = options || {}
  let currentUrl = String(url)
  let redirects = 0
  let activeReq = null
  let aborted = false

  let settle
  const promise = new Promise((resolve, reject) => {
    settle = { resolve, reject }
  })

  const finish = (err, resp, body) => {
    if (aborted && !err) return
    if (typeof callback === 'function') {
      try {
        callback(err, resp, body)
      } catch (_) {
        /* 回调内的异常不应影响宿主 */
      }
    }
    if (err) settle.reject(err)
    else settle.resolve({ resp, body })
  }

  function send() {
    if (aborted) return
    let parsed
    try {
      parsed = new URL(currentUrl)
    } catch (e) {
      return finish(new Error('无效的 URL: ' + currentUrl))
    }

    const method = String(opts.method || 'get').toUpperCase()
    const headers = normalizeHeaders(opts.headers)

    // 组装请求体
    let payload = null
    if (opts.form) {
      payload = encodeForm(opts.form)
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded'
      }
    } else if (typeof opts.formData === 'string') {
      payload = opts.formData
    } else if (opts.body !== undefined && opts.body !== null) {
      if (typeof opts.body === 'string') {
        payload = opts.body
      } else if (Buffer.isBuffer(opts.body) || ArrayBuffer.isView(opts.body)) {
        payload = Buffer.from(opts.body.buffer || opts.body, opts.body.byteOffset || 0, opts.body.byteLength)
        if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
          headers['Content-Type'] = 'application/octet-stream'
        }
      } else {
        payload = JSON.stringify(opts.body)
        if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
          headers['Content-Type'] = 'application/json'
        }
      }
    }

    if (payload && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-length')) {
      headers['Content-Length'] = Buffer.byteLength(payload)
    }

    const transport = isHttpsUrl(currentUrl) ? https : http
    const timeout = Math.min(Number(opts.timeout) > 0 ? Number(opts.timeout) : DEFAULT_TIMEOUT, 60000)

    const req = transport.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (isHttpsUrl(currentUrl) ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method,
        headers,
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const rawAll = Buffer.concat(chunks)
          const raw = decodeBody(rawAll, res.headers['content-encoding'])

          // 重定向跟随
          if (
            opts.redirect !== false &&
            [301, 302, 303, 307, 308].includes(res.statusCode) &&
            res.headers.location &&
            redirects < MAX_REDIRECTS
          ) {
            redirects++
            currentUrl = new URL(res.headers.location, currentUrl).toString()
            if (res.statusCode === 303) opts.method = 'GET'
            return send()
          }

          const text = raw.toString('utf8')
          let body = text
          try {
            body = JSON.parse(text)
          } catch (_) {
            /* 保留字符串 */
          }

          finish(null, {
            statusCode: res.statusCode,
            statusMessage: res.statusMessage,
            headers: res.headers,
            bytes: raw.length,
            raw,
            body,
          }, body)
        })
      }
    )

    activeReq = req

    req.on('error', (err) => finish(err))
    req.setTimeout(timeout, () => {
      req.destroy(new Error('请求超时 (' + timeout + 'ms)'))
    })

    req.end(payload || undefined)
  }

  send()

  return {
    abort() {
      aborted = true
      try {
        if (activeReq) activeReq.destroy()
      } catch (_) {}
    },
    promise,
  }
}

/**
 * Promise 风格封装：返回 resp（含 body / raw）
 */
function fetchLike(url, options) {
  return request(url, options).promise.then((r) => r.resp)
}

/**
 * 流式请求（用于音频/封面代理，不做缓冲）
 *
 * @param {string} url
 * @param {object} options { headers, timeout, redirect }
 * @returns {Promise<{statusCode:number, headers:object, stream:import('stream').Readable, abort:Function, finalUrl:string}>}
 */
function stream(url, options) {
  const opts = options || {}
  const timeout = Math.min(Number(opts.timeout) > 0 ? Number(opts.timeout) : 20000, 60000)

  const open = (target, redirects) =>
    new Promise((resolve, reject) => {
      let parsed
      try {
        parsed = new URL(target)
      } catch (e) {
        return reject(new Error('无效的 URL: ' + target))
      }
      const transport = isHttpsUrl(target) ? https : http
      const req = transport.request(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port || (isHttpsUrl(target) ? 443 : 80),
          path: parsed.pathname + parsed.search,
          method: opts.method || 'GET',
          headers: normalizeHeaders(opts.headers),
        },
        (res) => {
          // 跟随重定向（音频 CDN 常见 302）
          if (
            opts.redirect !== false &&
            [301, 302, 303, 307, 308].includes(res.statusCode) &&
            res.headers.location &&
            redirects < MAX_REDIRECTS
          ) {
            res.resume()
            const next = new URL(res.headers.location, target).toString()
            return open(next, redirects + 1).then(resolve, reject)
          }
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            stream: res,
            finalUrl: target,
            abort: () => {
              try {
                req.destroy()
              } catch (_) {}
            },
          })
        }
      )
      req.on('error', reject)
      req.setTimeout(timeout, () => req.destroy(new Error('上游请求超时')))
      req.end()
    })

  return open(String(url), 0)
}

module.exports = { request, fetchLike, stream, normalizeHeaders, DEFAULT_TIMEOUT }
