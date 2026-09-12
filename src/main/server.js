'use strict'

/**
 * HollyMusic 后端服务
 *
 * 组成：
 *   - 音源管理（导入/删除/启停，JSON 持久化，脚本 gzip 压缩存储）
 *   - LX 音源引擎（vm 沙箱执行自定义源 → 搜索/播放/歌词/封面）
 *   - 音频代理（服务端转发 + Range 断点续传，绕开 CORS/Referer 限制）
 *   - 歌单持久化（支持「移出歌单」）
 */

const express = require('express')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const crypto = require('crypto')

const httpClient = require('./lx/http')
const builtinSearch = require('./lx/builtin-search')

/* ------------------------------ 进程级容错 -------------------------------
 * 音源脚本在沙箱内会发起大量外部请求，上游抖动/断连产生的异常
 * 绝不能让整个服务退出。这里统一兜底，只记录日志。
 * ---------------------------------------------------------------------- */
process.on('unhandledRejection', (reason) => {
  const msg = reason && reason.message ? reason.message : String(reason)
  console.error('[unhandledRejection] ' + msg)
})
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException] ' + (err && err.message ? err.message : String(err)))
})

const app = express()
// 容器内监听端口（需与 docker-compose 端口映射右侧一致）
const PORT = Number(process.env.PORT) || 3000
// 数据目录：音源与歌单持久化在 ${DATA_DIR} 下
const DATA_DIR = process.env.DATA_DIR || '/app/config'
const SOURCES_FILE = path.join(DATA_DIR, 'sources.json')
const PLAYLIST_FILE = path.join(DATA_DIR, 'playlist.json')

/* ------------------------------- 数据持久化 ------------------------------- */

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })

function readJson(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    console.error('[data] 读取失败 ' + file + ': ' + e.message)
  }
  return fallback
}

function writeJson(file, data) {
  try {
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
    fs.renameSync(tmp, file)
  } catch (e) {
    console.error('[data] 写入失败 ' + file + ': ' + e.message)
  }
}

/* --------------------------------- 音源存储 -------------------------------- */

let sources = readJson(SOURCES_FILE, [])
if (!Array.isArray(sources)) sources = []

function saveSources() {
  writeJson(SOURCES_FILE, sources)
}

function deflateScript(script) {
  return new Promise((resolve, reject) => {
    zlib.deflate(Buffer.from(script, 'utf8'), (err, buf) => {
      if (err) reject(err)
      else resolve('gz_' + buf.toString('base64'))
    })
  })
}

function inflateScript(script) {
  if (typeof script === 'string' && script.startsWith('gz_')) {
    return new Promise((resolve, reject) => {
      zlib.inflate(Buffer.from(script.substring(3), 'base64'), (err, buf) => {
        if (err) reject(err)
        else resolve(buf.toString('utf8'))
      })
    })
  }
  return Promise.resolve(script || '')
}

function parseScriptInfo(script) {
  const result = /^\/\*[\S|\s]+?\*\//.exec(script)
  if (!result) throw new Error('无效的音源文件：缺少头部注释块')
  const info = {}
  const rxp = /^\s?\*?\s?@(\w+)\s(.+)$/
  for (const line of result[0].split(/\r?\n/)) {
    const m = rxp.exec(line)
    if (m) info[m[1]] = m[2].trim().slice(0, 1024)
  }
  info.name ||= `音源_${Date.now()}`
  return info
}

/** 供 SourceManager 读取（只给启用的音源，脚本已解压） */
async function getEnabledSources() {
  const out = []
  for (const s of sources) {
    if (s.enabled === false) continue
    try {
      out.push({ id: s.id, name: s.name, script: await inflateScript(s.script) })
    } catch (e) {
      console.error('[sources] 解压失败 ' + s.id + ': ' + e.message)
    }
  }
  return out
}

/* -------------------------------- 歌单存储 -------------------------------- */

let playlist = readJson(PLAYLIST_FILE, [])
if (!Array.isArray(playlist)) playlist = []

function savePlaylist() {
  writeJson(PLAYLIST_FILE, playlist)
}

/* ------------------------------- 音源引擎 -------------------------------- */

const { SourceManager } = require('./lx/manager')

const manager = new SourceManager({
  getSources: getEnabledSources,
  log: (...a) => console.log(...a),
})

/* --------------------------------- 中间件 --------------------------------- */

app.use(express.json({ limit: '10mb' }))
app.use(express.static(path.join(__dirname, '../renderer')))

function ok(res, data) {
  res.json(data)
}
function fail(res, message, code) {
  res.status(code || 400).json({ success: false, error: String(message) })
}

/** 包装 async 路由，统一错误处理 */
const wrap = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error('[api] ' + req.path + ' → ' + (e && e.message))
    if (!res.headersSent) fail(res, (e && e.message) || '服务端错误', 500)
  })
}

/* --------------------------------- 基础接口 -------------------------------- */

app.get('/api/health', (req, res) => {
  ok(res, { status: 'ok', timestamp: new Date().toISOString() })
})

app.get('/api/status', (req, res) => {
  const st = manager.status()
  ok(res, {
    ...st,
    sourceCount: sources.length,
    enabledCount: sources.filter((s) => s.enabled !== false).length,
    playlistCount: playlist.length,
    dataDir: DATA_DIR,
    port: PORT,
  })
})

/* --------------------------------- 音源管理 -------------------------------- */

app.get('/api/sources', (req, res) => {
  ok(
    res,
    sources.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description || '',
      author: s.author || '',
      version: s.version || '',
      enabled: s.enabled !== false,
    }))
  )
})

app.post(
  '/api/sources',
  wrap(async (req, res) => {
    const script = String((req.body && req.body.script) || '').trim()
    if (!script) return fail(res, '缺少脚本内容')
    const info = parseScriptInfo(script)
    const compressed = await deflateScript(script)

    for (const s of sources) {
      if (s.script === compressed) return fail(res, `导入失败：与已有音源「${s.name}」内容相同`)
    }

    const item = {
      id: `source_${crypto.randomBytes(4).toString('hex')}_${Date.now()}`,
      name: info.name,
      description: info.description || '',
      author: info.author || '',
      version: info.version || '',
      homepage: info.homepage || '',
      enabled: true,
      script: compressed,
    }
    sources.push(item)
    saveSources()

    const status = await manager.reload()
    ok(res, { success: true, source: { ...item, script: undefined }, status })
  })
)

app.patch(
  '/api/sources',
  wrap(async (req, res) => {
    const { id, enabled } = req.body || {}
    const target = sources.find((s) => s.id === id)
    if (!target) return fail(res, '音源不存在', 404)
    target.enabled = enabled !== false
    saveSources()
    const status = await manager.reload()
    ok(res, { success: true, status })
  })
)

app.delete(
  '/api/sources',
  wrap(async (req, res) => {
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : []
    if (!ids.length) return fail(res, '缺少要删除的音源 id')
    const before = sources.length
    sources = sources.filter((s) => !ids.includes(s.id))
    saveSources()
    const status = await manager.reload()
    ok(res, { success: true, removed: before - sources.length, status })
  })
)

app.post(
  '/api/sources/reload',
  wrap(async (req, res) => {
    ok(res, await manager.reload())
  })
)

/* ------------------------------- 平台与音质 ------------------------------- */

const PLATFORM_NAMES = {
  kw: '酷我音乐',
  kg: '酷狗音乐',
  tx: 'QQ音乐',
  wy: '网易云音乐',
  mg: '咪咕音乐',
  local: '本地音乐',
}

app.get('/api/platforms', (req, res) => {
  const index = manager.platformIndex()
  const platforms = manager.availablePlatforms().map((p) => ({
    id: p,
    name: PLATFORM_NAMES[p] || p,
    qualitys: manager.qualitysOf(p),
    sources: (index[p] || []).map((r) => r.scriptInfo.name || r.id),
    searchable:
      (index[p] || []).some((r) => r.supportsAction(p, 'search')) || builtinSearch.isSupported(p),
  }))
  ok(res, { platforms })
})

/* --------------------------------- 搜索 ---------------------------------- */

app.get(
  '/api/search',
  wrap(async (req, res) => {
    const keyword = String(req.query.keyword || req.query.keywords || req.query.q || '').trim()
    if (!keyword) return fail(res, '缺少搜索关键词')
    const result = await manager.search({
      keyword,
      source: req.query.source || 'all',
      page: req.query.page || 1,
      limit: req.query.limit || req.query.pagesize || 30,
    })
    ok(res, result)
  })
)

/** 兼容 HollyMusic 客户端：返回可搜索平台 */
app.get('/api/search-sources', (req, res) => {
  const index = manager.platformIndex()
  ok(
    res,
    manager.availablePlatforms().map((p) => ({
      id: p,
      name: PLATFORM_NAMES[p] || p,
      sources: (index[p] || []).map((r) => r.scriptInfo.name || r.id),
    }))
  )
})

/* ------------------------------- 播放地址 -------------------------------- */

app.get(
  '/api/music-url',
  wrap(async (req, res) => {
    const uid = String(req.query.uid || '')
    if (!uid) return fail(res, '缺少 uid')
    ok(res, await manager.getMusicUrl(uid, req.query.quality))
  })
)

/* --------------------------- 音频代理（支持 Range） ------------------------- */

const REFERER = {
  kw: 'https://www.kuwo.cn/',
  kg: 'http://www.kugou.com/',
  tx: 'https://y.qq.com/',
  wy: 'https://music.163.com/',
  mg: 'https://m.music.migu.cn/',
}

function guessExt(contentType, quality) {
  const ct = String(contentType || '').toLowerCase()
  if (ct.includes('flac')) return '.flac'
  if (ct.includes('wav')) return '.wav'
  if (ct.includes('aac') || ct.includes('mp4')) return '.m4a'
  if (ct.includes('ogg')) return '.ogg'
  if (ct.includes('mpeg')) return '.mp3'
  return /flac|24bit|hires|lossless/i.test(String(quality || '')) ? '.flac' : '.mp3'
}

function sanitizeFilename(name) {
  return String(name).replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 180)
}

async function proxyAudio(req, res, { download }) {
  const uid = String(req.query.uid || '')
  if (!uid) return fail(res, '缺少 uid')

  const info = await manager.getMusicUrl(uid, req.query.quality)
  const entry = manager.getSong(uid)
  const song = entry ? entry.song : null
  const source = info.source || (song && song.source)

  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
    Accept: '*/*',
  }
  if (REFERER[source]) headers.Referer = REFERER[source]
  // 透传 Range → 支持拖动进度与断点续传
  if (req.headers.range) headers.Range = req.headers.range

  const upstream = await httpClient.stream(info.url, { headers, redirect: true })

  if (upstream.statusCode >= 400) {
    upstream.stream.resume()
    return fail(res, `上游返回 ${upstream.statusCode}，该音质可能无版权或链接已失效`, 502)
  }

  for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    if (upstream.headers[k] !== undefined) res.setHeader(k, upstream.headers[k])
  }
  if (!res.getHeader('content-type')) res.setHeader('content-type', 'audio/mpeg')
  if (!res.getHeader('accept-ranges')) res.setHeader('accept-ranges', 'bytes')

  if (download) {
    const ext = guessExt(upstream.headers['content-type'], info.quality)
    const safeName = sanitizeFilename(song ? `${song.singer} - ${song.name}${ext}` : `music${ext}`)
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`
    )
  }

  res.status(upstream.statusCode === 206 ? 206 : 200)
  upstream.stream.pipe(res)
  upstream.stream.on('error', () => {
    try {
      res.destroy()
    } catch (_) {}
  })
}

app.get('/api/audio', wrap((req, res) => proxyAudio(req, res, { download: false })))
app.get('/api/download', wrap((req, res) => proxyAudio(req, res, { download: true })))

/* -------------------------------- 歌词/封面 ------------------------------- */

app.get(
  '/api/lyric',
  wrap(async (req, res) => {
    const uid = String(req.query.uid || '')
    if (!uid) return fail(res, '缺少 uid')
    const lyric = await manager.getLyric(uid)
    if (!lyric) return fail(res, '该歌曲没有可用歌词（音源未提供 lyric 动作）', 404)
    ok(res, lyric)
  })
)

app.get(
  '/api/cover',
  wrap(async (req, res) => {
    let target = String(req.query.url || '')
    if (!target) {
      const uid = String(req.query.uid || '')
      if (!uid) return fail(res, '缺少 uid 或 url')
      target = await manager.getPic(uid)
      if (!target) return fail(res, '没有可用封面', 404)
    }
    const upstream = await httpClient.stream(target, { redirect: true })
    if (upstream.statusCode >= 400) {
      upstream.stream.resume()
      return fail(res, `上游返回 ${upstream.statusCode}`, 502)
    }
    for (const k of ['content-type', 'content-length', 'cache-control']) {
      if (upstream.headers[k] !== undefined) res.setHeader(k, upstream.headers[k])
    }
    res.status(200)
    upstream.stream.pipe(res)
  })
)

/* --------------------------------- 歌单 ---------------------------------- */

app.get('/api/playlist', (req, res) => {
  ok(res, { list: playlist, total: playlist.length })
})

app.post(
  '/api/playlist',
  wrap(async (req, res) => {
    const songs = Array.isArray(req.body && req.body.songs) ? req.body.songs : []
    if (!songs.length) return fail(res, '缺少要添加的歌曲')

    let added = 0
    for (const s of songs) {
      if (!s || !s.name) continue
      // 前端通常只回传 uid + 展示字段；若缺 ID 字段，则从服务端歌曲缓存补全，
      // 否则歌单会丢 ID（导出后再导入将无法播放）
      let payload = s
      if (!s.songmid && !s.hash && !s.copyrightId && !s.id && s.uid) {
        const cached = manager.getSong(s.uid)
        if (cached && cached.song) payload = { ...cached.song, ...s }
      }
      const entry = normalizeSongEntry(payload)
      const at = playlist.findIndex((x) => x.uid === entry.uid)
      if (at >= 0) {
        // 已存在则更新元数据，保留原始加入时间
        playlist[at] = { ...entry, addedAt: playlist[at].addedAt }
      } else {
        playlist.push(entry)
        added++
      }
      if (!manager.getSong(entry.uid)) manager.putSong(entry)
    }
    savePlaylist()
    ok(res, { success: true, added, total: playlist.length, list: playlist })
  })
)

app.delete(
  '/api/playlist',
  wrap(async (req, res) => {
    const uids = Array.isArray(req.body && req.body.uids) ? req.body.uids : []
    if (!uids.length) return fail(res, '缺少要移除的歌曲 uid')
    const before = playlist.length
    playlist = playlist.filter((x) => !uids.includes(x.uid))
    savePlaylist()
    ok(res, { success: true, removed: before - playlist.length, total: playlist.length, list: playlist })
  })
)

app.put(
  '/api/playlist',
  wrap(async (req, res) => {
    const uids = Array.isArray(req.body && req.body.uids) ? req.body.uids : null
    if (!uids) return fail(res, '缺少 uids')
    const map = new Map(playlist.map((x) => [x.uid, x]))
    playlist = uids.map((u) => map.get(u)).filter(Boolean)
    savePlaylist()
    ok(res, { success: true, total: playlist.length, list: playlist })
  })
)

/* ----------------------------- 歌单导入 / 导出 ----------------------------- */

/** 归一化一首歌为歌单条目（补齐 id 字段，保证导回后可播放） */
function normalizeSongEntry(input) {
  const s = input || {}
  const pid = String(s.songmid || s.hash || s.copyrightId || s.id || '')
  const base = {
    source: String(s.source || ''),
    name: String(s.name || ''),
    singer: String(s.singer || ''),
    albumName: String(s.albumName || ''),
    albumId: s.albumId == null ? '' : String(s.albumId),
    songmid: pid,
    hash: String(s.hash || pid),
    copyrightId: String(s.copyrightId || pid),
    id: String(s.id || pid),
    interval: Number(s.interval) || 0,
    img: String(s.img || ''),
    addedAt: Number(s.addedAt) || Date.now(),
  }
  // uid 一律用服务端算法重算：必须与播放缓存（manager.putSong）的键一致，
  // 否则导入的歌单点击播放会报「歌曲不存在」。文件里的原 uid 仅用于去重比对。
  base.uid = SourceManager.uidOf(base)
  return base
}

/** 去重键：服务端 uid + 文件原 uid（若有）+ 平台&歌曲ID */
function dedupKeys(entry, incomingUid) {
  const keys = [entry.uid]
  if (incomingUid && incomingUid !== entry.uid) keys.push(String(incomingUid))
  if (entry.songmid) keys.push(`${entry.source}::${entry.songmid}`)
  return keys
}

app.get('/api/playlist/export', (req, res) => {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')
  const filename = `hollymusic-playlist-${stamp}.json`
  const payload = {
    type: 'hollymusic-playlist',
    version: 1,
    exportedAt: new Date().toISOString(),
    count: playlist.length,
    songs: playlist,
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`
  )
  res.send(JSON.stringify(payload, null, 2))
})

app.post(
  '/api/playlist/import',
  wrap(async (req, res) => {
    const body = req.body || {}
    let raw = null
    let replace = false

    if (Array.isArray(body)) {
      raw = body
    } else if (Array.isArray(body.songs)) {
      raw = body.songs
      replace = body.replace === true
    } else if (typeof body.text === 'string') {
      // 允许直接提交导出的 JSON 文本
      try {
        const parsed = JSON.parse(body.text)
        if (Array.isArray(parsed)) raw = parsed
        else if (parsed && Array.isArray(parsed.songs)) {
          raw = parsed.songs
          replace = body.replace === true
        }
      } catch (e) {
        return fail(res, '导入失败：文件不是合法 JSON（' + e.message + '）')
      }
    }

    if (!raw) {
      return fail(res, '导入失败：格式不正确，应为 HollyMusic 导出的歌单 JSON（含 songs 数组）')
    }

    const target = (replace ? [] : playlist).map((x) => normalizeSongEntry(x))
    const seen = new Set()
    for (const item of target) for (const k of dedupKeys(item, item.uid)) seen.add(k)

    let imported = 0
    let skipped = 0
    let invalid = 0

    for (const item of raw) {
      if (!item || typeof item !== 'object' || !item.name) {
        invalid++
        continue
      }
      const entry = normalizeSongEntry(item)
      const keys = dedupKeys(entry, item.uid)
      if (keys.some((k) => seen.has(k))) {
        skipped++
        continue
      }
      for (const k of keys) seen.add(k)
      target.push(entry)
      imported++
      // 注册到播放缓存，导回后立即可播（键与 entry.uid 一致）
      if (!manager.getSong(entry.uid)) manager.putSong(entry)
    }

    playlist = target
    savePlaylist()

    ok(res, {
      success: true,
      imported,
      skipped,
      invalid,
      replaced: replace,
      total: playlist.length,
      list: playlist,
    })
  })
)

/* --------------------------------- 启动 ---------------------------------- */

app.listen(PORT, () => {
  console.log(`HollyMusic server running on port ${PORT}`)
  console.log(`数据目录: ${DATA_DIR}`)
  manager
    .reload()
    .then((st) => {
      console.log(`已加载音源 ${st.count} 个，可用平台: ${st.platforms.join(', ') || '无'}`)
      for (const e of st.errors) {
        console.warn(`  音源加载失败 ${e.name || e.id}: ${e.error}`)
      }
    })
    .catch((e) => console.error('音源初始化失败: ' + e.message))
})

module.exports = app
