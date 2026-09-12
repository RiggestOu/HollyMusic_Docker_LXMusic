'use strict'

/**
 * 音源管理器
 *
 * 职责：
 *   - 加载全部已启用音源脚本（每个脚本一个沙箱 + 运行器）
 *   - 统一对外提供 search / getMusicUrl / getLyric / getPic
 *   - 音质协商（把请求音质映射到音源真正认得的档位）
 *   - 多音源回退（同一平台可由多个音源提供，逐个尝试直到成功）
 *   - 歌曲信息缓存（对外只暴露 uid，避免把 musicInfo 在前后端来回搬）
 */

const crypto = require('crypto')
const { LXRunner } = require('./runner')
const qualityLib = require('./quality')
const builtin = require('./builtin-search')

const SONG_CACHE_MAX = 5000
const URL_CACHE_TTL = 5 * 60 * 1000

class SourceManager {
  /**
   * @param {object} opts
   * @param {function} opts.getSources () => Promise<Array<{id:string,name:string,script:string}>> | Array
   * @param {function} [opts.log]
   */
  constructor(opts) {
    const o = opts || {}
    this.getSources = typeof o.getSources === 'function' ? o.getSources : async () => []
    this.log = typeof o.log === 'function' ? o.log : () => {}

    /** @type {Map<string, LXRunner>} */
    this.runners = new Map()
    /** uid → { song, musicInfo, ts } */
    this.songCache = new Map()
    /** url cache key → { url, ts } */
    this.urlCache = new Map()

    this.loadedAt = 0
    this.loading = null
    this.errors = []
  }

  /* ----------------------------- 加载 / 重载 ----------------------------- */

  async reload() {
    if (this.loading) return this.loading
    this.loading = (async () => {
      for (const r of this.runners.values()) {
        try {
          r.dispose()
        } catch (_) {}
      }
      this.runners.clear()
      this.errors = []
      // 音源变更后旧的播放地址可能已失效，必须清空
      this.urlCache.clear()

      let list = []
      try {
        list = (await this.getSources()) || []
      } catch (e) {
        this.errors.push({ id: '-', error: '读取音源列表失败: ' + (e && e.message) })
      }

      for (const item of list) {
        if (!item || !item.script) continue
        const runner = new LXRunner({ id: item.id, script: item.script, log: this.log })
        try {
          await runner.load()
          this.runners.set(item.id, runner)
          const platforms = Object.keys(runner.sources)
          this.log(`[manager] 音源「${runner.scriptInfo.name || item.id}」就绪，平台: ${platforms.join(', ') || '无'}`)
        } catch (e) {
          this.errors.push({ id: item.id, name: item.name, error: (e && e.message) || String(e) })
          this.log(`[manager] 音源「${item.name || item.id}」加载失败: ${(e && e.message) || e}`)
        }
      }

      this.loadedAt = Date.now()
      this.loading = null
      return this.status()
    })()
    return this.loading
  }

  status() {
    const sources = []
    for (const [id, r] of this.runners) {
      const meta = r.getMeta()
      sources.push(meta)
    }
    return {
      loadedAt: this.loadedAt,
      count: sources.length,
      sources,
      errors: this.errors.slice(),
      platforms: this.availablePlatforms(),
    }
  }

  /** 当前可用的平台 → 提供该平台的音源列表 */
  platformIndex() {
    const index = {}
    for (const [id, r] of this.runners) {
      for (const source of Object.keys(r.sources)) {
        if (!index[source]) index[source] = []
        index[source].push(r)
      }
    }
    return index
  }

  availablePlatforms() {
    const set = new Set(Object.keys(this.platformIndex()))
    for (const p of builtin.SUPPORTED) set.add(p)
    return Array.from(set)
  }

  /** 某平台的音质并集 */
  qualitysOf(source) {
    const index = this.platformIndex()
    const list = []
    for (const r of index[source] || []) {
      for (const q of r.qualitysOf(source)) if (!list.includes(q)) list.push(q)
    }
    if (!list.length) return qualityLib.DEFAULT_ORDER.slice()
    return list
  }

  /* ------------------------------- 歌曲缓存 ------------------------------ */

  static uidOf(song) {
    const key = [song.source, song.songmid || song.hash || song.id, song.name, song.singer].join('|')
    return crypto.createHash('md5').update(key).digest('hex').slice(0, 16)
  }

  putSong(song) {
    const uid = SourceManager.uidOf(song)
    this.songCache.set(uid, { song, ts: Date.now() })
    if (this.songCache.size > SONG_CACHE_MAX) {
      // 简单淘汰：清掉最旧的 500 条
      const keys = Array.from(this.songCache.keys()).slice(0, 500)
      for (const k of keys) this.songCache.delete(k)
    }
    return uid
  }

  getSong(uid) {
    return this.songCache.get(uid) || null
  }

  /** 从 uid 还原 musicInfo（交给音源脚本的对象） */
  toMusicInfo(song) {
    return {
      source: song.source,
      name: song.name,
      singer: song.singer,
      albumName: song.albumName,
      albumId: song.albumId,
      songmid: song.songmid,
      hash: song.hash,
      copyrightId: song.copyrightId,
      id: song.id,
      interval: song.interval,
      img: song.img,
    }
  }

  /* -------------------------------- 搜索 -------------------------------- */

  /**
   * @param {object} opts
   * @param {string} opts.keyword
   * @param {string} [opts.source]   平台（kw/kg/tx/wy/mg）或 'all'
   * @param {number} [opts.page]
   * @param {number} [opts.limit]
   */
  async search(opts) {
    const keyword = String((opts && opts.keyword) || '').trim()
    if (!keyword) return { list: [], total: 0, isEnd: true, platforms: [] }

    const page = Math.max(1, Number(opts.page) || 1)
    const limit = Math.min(60, Math.max(1, Number(opts.limit) || 30))
    const want = String((opts && opts.source) || 'all').trim() || 'all'

    const index = this.platformIndex()
    let platforms
    if (want === 'all') {
      platforms = this.availablePlatforms().filter(
        (p) => index[p] || builtin.isSupported(p)
      )
    } else {
      platforms = [want]
    }

    const collected = []
    const details = []

    for (const platform of platforms) {
      const runners = index[platform] || []
      let done = false

      // 1) 优先使用音源自带的 musicSearch
      for (const runner of runners) {
        if (!runner.supportsAction(platform, 'search')) continue
        try {
          const res = await runner.search(platform, { keyword, page, pagesize: limit })
          if (Array.isArray(res.list) && res.list.length) {
            for (const s of res.list) {
              if (!s || !s.name) continue
              collected.push({ ...s, source: s.source || platform })
            }
            details.push({ platform, via: 'source:' + (runner.scriptInfo.name || runner.id), count: res.list.length })
            done = true
            break
          }
          details.push({ platform, via: 'source:' + (runner.scriptInfo.name || runner.id), count: 0 })
        } catch (e) {
          details.push({ platform, via: 'source:' + (runner.scriptInfo.name || runner.id), error: (e && e.message) || String(e) })
        }
      }

      // 2) 回退到内置检索
      if (!done && builtin.isSupported(platform)) {
        const res = await builtin.search(platform, keyword, page, limit)
        if (Array.isArray(res.list) && res.list.length) {
          for (const s of res.list) collected.push(s)
          details.push({ platform, via: 'builtin', count: res.list.length })
        } else {
          details.push({ platform, via: 'builtin', count: 0, error: res.error })
        }
      }
    }

    // 去重 + 生成 uid
    const seen = new Set()
    const list = []
    for (const song of collected) {
      const uid = SourceManager.uidOf(song)
      if (seen.has(uid)) continue
      seen.add(uid)
      this.putSong(song)
      list.push({
        uid,
        source: song.source,
        name: song.name,
        singer: song.singer,
        albumName: song.albumName,
        // 一并返回 ID 字段：加入歌单/导出时需要，避免前端回传时丢 ID
        albumId: song.albumId || '',
        songmid: song.songmid || '',
        hash: song.hash || '',
        copyrightId: song.copyrightId || '',
        id: song.id || '',
        interval: song.interval,
        img: song.img,
        qualitys: this.qualitysOf(song.source),
      })
    }

    return { list, total: list.length, isEnd: list.length < limit, platforms: details, keyword, page }
  }

  /* ------------------------------- 播放地址 ------------------------------ */

  /**
   * 取播放地址（多音源回退 + 音质协商）
   * @returns {Promise<{url:string, quality:string, via:string}>}
   */
  async getMusicUrl(uid, requestedQuality) {
    const entry = this.getSong(uid)
    if (!entry) throw new Error('歌曲不存在或已过期，请重新搜索')
    const song = entry.song
    const source = song.source

    const key = uid + '::' + (requestedQuality || '')
    const cached = this.urlCache.get(key)
    if (cached && Date.now() - cached.ts < URL_CACHE_TTL) {
      return { url: cached.url, quality: cached.quality, via: cached.via, cached: true }
    }

    const index = this.platformIndex()
    let runners = index[source] || []
    if (!runners.length) {
      throw new Error(`没有可用音源提供平台 ${source}，请先在「音源管理」中导入支持该平台的音源`)
    }
    // 只保留声明了 musicUrl 的音源
    runners = runners.filter((r) => r.supportsAction(source, 'musicUrl'))
    if (!runners.length) throw new Error(`平台 ${source} 的音源均未声明 musicUrl 动作`)

    const musicInfo = this.toMusicInfo(song)
    const errors = []

    for (const runner of runners) {
      const supported = runner.qualitysOf(source)
      const quality = qualityLib.negotiate(requestedQuality || '320k', supported)
      try {
        const url = await runner.getMusicUrl(source, musicInfo, quality)
        this.urlCache.set(key, { url, quality, via: runner.scriptInfo.name || runner.id, ts: Date.now() })
        return {
          url,
          quality,
          requestedQuality: requestedQuality || '320k',
          via: runner.scriptInfo.name || runner.id,
          source,
        }
      } catch (e) {
        const msg = (e && e.message) || String(e)
        errors.push(`${runner.scriptInfo.name || runner.id}(${quality}): ${msg}`)

        // 当前音质失败时，尝试同音源更低档位
        const fallbacks = qualityLib.DEFAULT_ORDER.filter(
          (q) => qualityLib.tierIndex(q) > qualityLib.tierIndex(quality)
        )
        for (const q of fallbacks) {
          const real = qualityLib.negotiate(q, supported)
          if (real === quality) continue
          try {
            const url = await runner.getMusicUrl(source, musicInfo, real)
            this.urlCache.set(key, { url, quality: real, via: runner.scriptInfo.name || runner.id, ts: Date.now() })
            return {
              url,
              quality: real,
              requestedQuality: requestedQuality || '320k',
              via: runner.scriptInfo.name || runner.id,
              source,
              downgraded: true,
            }
          } catch (e2) {
            errors.push(`${runner.scriptInfo.name || runner.id}(${real}): ${(e2 && e2.message) || e2}`)
          }
        }
      }
    }

    throw new Error(`获取播放地址失败 —— ${errors.join('; ')}`)
  }

  /* -------------------------------- 歌词 --------------------------------- */

  async getLyric(uid) {
    const entry = this.getSong(uid)
    if (!entry) throw new Error('歌曲不存在或已过期')
    const song = entry.song
    const runners = (this.platformIndex()[song.source] || []).filter((r) =>
      r.supportsAction(song.source, 'lyric')
    )
    const musicInfo = this.toMusicInfo(song)
    for (const r of runners) {
      try {
        const res = await r.getLyric(song.source, musicInfo)
        if (res && (res.lyric || res.tlyric)) return { ...res, via: r.scriptInfo.name || r.id }
      } catch (_) {}
    }
    return null
  }

  /* -------------------------------- 封面 --------------------------------- */

  async getPic(uid) {
    const entry = this.getSong(uid)
    if (!entry) return null
    const song = entry.song
    if (song.img) return song.img
    const runners = (this.platformIndex()[song.source] || []).filter((r) =>
      r.supportsAction(song.source, 'pic')
    )
    const musicInfo = this.toMusicInfo(song)
    for (const r of runners) {
      try {
        const url = await r.getPic(song.source, musicInfo)
        if (url) return url
      } catch (_) {}
    }
    return null
  }

  /* ------------------------------ 已有客户端兼容 --------------------------- */

  /** 兼容 HollyMusic 客户端 /api/audio?uid=&quality= 的调用习惯 */
  async resolveAudio(uid, quality) {
    const info = await this.getMusicUrl(uid, quality)
    const entry = this.getSong(uid)
    return { ...info, song: entry ? entry.song : null }
  }
}

module.exports = { SourceManager }
