'use strict'

/**
 * 内置逐平台搜索（回退方案）
 *
 * 背景：LX 自定义源的标准动作是 musicUrl / lyric / pic，
 * 只有部分源（如「全豆要聚合」的汽水）额外提供 musicSearch。
 * 因此当音源不提供搜索时，用这里的实现按平台直接检索，
 * 参考 lx-music-desktop 的 musicSdk 检索接口。
 *
 * 统一输出为 LX 歌曲信息（songmid / hash / copyrightId / id 一并填充，
 * 以兼容不同音源对 id 字段的读取习惯）。
 */

const http = require('./http')

const SEARCH_TIMEOUT = 12000

const UA_MOBILE =
  'Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/104.0 Mobile Safari/537.36'

function num(v, d = 0) {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

/** 构造 LX 歌曲信息（id 字段多路填充，兼容各音源读取习惯） */
function makeSong(part) {
  const id = part.id == null ? '' : String(part.id)
  const song = {
    source: part.source,
    name: part.name || '未知歌曲',
    singer: part.singer || '未知歌手',
    albumName: part.albumName || '',
    albumId: part.albumId == null ? id : String(part.albumId),
    songmid: id,
    hash: id,
    copyrightId: part.copyrightId == null ? id : String(part.copyrightId),
    id,
    interval: num(part.interval, 0),
    img: part.img || '',
    _types: part._types || {},
    types: [],
    typeUrl: {},
  }
  song.types = Object.keys(song._types)
  return song
}

/* ------------------------------- 酷我 kw ------------------------------- */
async function searchKw(keyword, page, size) {
  const url =
    'http://search.kuwo.cn/r.s?' +
    new URLSearchParams({
      client: 'kt',
      all: keyword,
      pn: String(page - 1),
      rn: String(size),
      uid: '794762570',
      ver: 'kwplayer_ar_9.2.2.1',
      vipver: '1',
      show_copyright_off: '1',
      newver: '1',
      ft: 'music',
      cluster: '0',
      strategy: '2012',
      encoding: 'utf8',
      rformat: 'json',
      vermerge: '1',
      mobi: '1',
    }).toString()

  const resp = await http.fetchLike(url, { timeout: SEARCH_TIMEOUT, headers: { 'User-Agent': UA_MOBILE } })
  let body = resp.body
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body.replace(/&nbsp;/g, ' '))
    } catch (_) {
      return { list: [], isEnd: true, total: 0 }
    }
  }
  const arr = Array.isArray(body && body.abslist) ? body.abslist : []
  const list = arr.map((it) => {
    const rawId = String(it.MUSICRID || it.musicrid || '')
    const id = rawId.includes('_') ? rawId.split('_').pop() : rawId
    return makeSong({
      source: 'kw',
      id,
      name: it.SONGNAME || it.songname,
      singer: (it.ARTIST || it.artist || '').replace(/&/g, '/'),
      albumName: it.ALBUM || it.album || '',
      albumId: it.ALBUMID || it.albumid,
      interval: it.DURATION || it.duration,
      img: it.web_albumpic_short
        ? 'https://img1.kuwo.cn/star/albumcover/' + it.web_albumpic_short
        : '',
    })
  })
  return { list, isEnd: list.length < size, total: num(body && body.TOTAL, list.length) }
}

/* ------------------------------- 酷狗 kg ------------------------------- */
async function searchKg(keyword, page, size) {
  const url =
    'http://mobilecdn.kugou.com/api/v3/search/song?' +
    new URLSearchParams({
      format: 'json',
      keyword,
      page: String(page),
      pagesize: String(size),
      showtype: '1',
    }).toString()

  const resp = await http.fetchLike(url, { timeout: SEARCH_TIMEOUT, headers: { 'User-Agent': UA_MOBILE } })
  const data = (resp.body && resp.body.data) || {}
  const arr = Array.isArray(data.info) ? data.info : []
  const list = arr.map((it) => {
    const id = String(it.hash || it.hash_128 || '')
    const _types = {}
    if (it.filesize) _types['128k'] = { size: it.filesize }
    if (it['320filesize']) _types['320k'] = { size: it['320filesize'] }
    if (it.sqfilesize) _types.flac = { size: it.sqfilesize }
    if (it.filesize_ape) _types.ape = { size: it.filesize_ape }
    let name = it.songname || it.filename || ''
    if (!it.songname && it.filename && String(it.filename).includes(' - ')) {
      name = String(it.filename).split(' - ').slice(1).join(' - ')
    }
    return makeSong({
      source: 'kg',
      id,
      name,
      singer: it.singername || '',
      albumName: it.album_name || '',
      albumId: it.album_id,
      interval: it.duration,
      img: it.album_id ? `https://imge.kugou.com/stdmusic/240/${it.album_id}.jpg` : '',
      _types,
    })
  })
  return { list, isEnd: list.length < size, total: num(data.total, list.length) }
}

/* ------------------------------ QQ 音乐 tx ----------------------------- */
async function searchTx(keyword, page, size) {
  const url =
    'https://c.y.qq.com/soso/fcgi-bin/client_search_cp?' +
    new URLSearchParams({
      p: String(page),
      n: String(size),
      w: keyword,
      format: 'json',
      cr: '1',
      new_json: '1',
      t: '0',
      aggr: '1',
      lossless: '0',
    }).toString()

  const resp = await http.fetchLike(url, {
    timeout: SEARCH_TIMEOUT,
    headers: {
      'User-Agent': UA_MOBILE,
      Referer: 'https://y.qq.com/portal/search.html',
      Origin: 'https://y.qq.com',
    },
  })

  let body = resp.body
  if (typeof body === 'string') {
    const m = /callback\(([\s\S]*)\)/.exec(body)
    try {
      body = JSON.parse(m ? m[1] : body)
    } catch (_) {
      return { list: [], isEnd: true, total: 0 }
    }
  }

  const song = (body && body.data && body.data.song) || {}
  const arr = Array.isArray(song.list) ? song.list : []
  const list = arr.map((it) => {
    const id = String(it.mid || it.songmid || '')
    const singers = Array.isArray(it.singer)
      ? it.singer.map((s) => s && s.name).filter(Boolean).join('/')
      : it.singername || ''
    const albumMid = (it.album && (it.album.mid || it.album.pmid)) || it.albummid || ''
    const _types = {}
    if (it.file && it.file.size_128mp3) _types['128k'] = { size: it.file.size_128mp3 }
    if (it.file && it.file.size_320mp3) _types['320k'] = { size: it.file.size_320mp3 }
    if (it.file && it.file.size_flac) _types.flac = { size: it.file.size_flac }
    if (it.file && it.file.size_hires) _types.flac24bit = { size: it.file.size_hires }
    return makeSong({
      source: 'tx',
      id,
      name: it.name || it.songname,
      singer: singers,
      albumName: (it.album && (it.album.name || it.album.title)) || it.albumname || '',
      albumId: albumMid,
      interval: it.interval,
      img: albumMid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albumMid}.jpg` : '',
      _types,
    })
  })
  return { list, isEnd: list.length < size, total: num(song.totalnum, list.length) }
}

/* ------------------------------ 网易云 wy ------------------------------ */
async function searchWy(keyword, page, size) {
  const url =
    'https://music.163.com/api/search/get/web?' +
    new URLSearchParams({
      s: keyword,
      type: '1',
      offset: String((page - 1) * size),
      limit: String(size),
      total: 'true',
    }).toString()

  const resp = await http.fetchLike(url, {
    timeout: SEARCH_TIMEOUT,
    headers: {
      'User-Agent': UA_MOBILE,
      Referer: 'https://music.163.com/',
      Cookie: 'appver=2.0.2; os=pc',
    },
  })

  const result = (resp.body && resp.body.result) || {}
  const arr = Array.isArray(result.songs) ? result.songs : []
  const list = arr.map((it) => {
    const id = String(it.id || '')
    const _types = {}
    if (it.h) _types.flac = { size: it.h && it.h.size }
    if (it.m) _types['320k'] = { size: it.m && it.m.size }
    if (it.l) _types['128k'] = { size: it.l && it.l.size }
    if (it.sq) _types.flac = { size: it.sq && it.sq.size }
    const album = it.album || {}
    return makeSong({
      source: 'wy',
      id,
      name: it.name,
      singer: Array.isArray(it.artists) ? it.artists.map((a) => a && a.name).filter(Boolean).join('/') : '',
      albumName: album.name || '',
      albumId: album.id,
      interval: it.duration ? Math.round(num(it.duration) / 1000) : 0,
      img: album.picUrl || '',
      _types,
    })
  })
  return { list, isEnd: list.length < size, total: num(result.songCount, list.length) }
}

/* ------------------------------- 咪咕 mg ------------------------------- */
async function searchMg(keyword, page, size) {
  const url =
    'https://m.music.migu.cn/migu/remoting/scr_search_tag?' +
    new URLSearchParams({
      keyword,
      type: '2',
      rows: String(size),
      pgc: String(page),
    }).toString()

  const resp = await http.fetchLike(url, {
    timeout: SEARCH_TIMEOUT,
    headers: {
      'User-Agent': UA_MOBILE,
      Referer: 'https://m.music.migu.cn/v3/music/player/audio',
    },
  })

  const arr = Array.isArray(resp.body && resp.body.musics) ? resp.body.musics : []
  const list = arr.map((it) => {
    const id = String(it.copyrightId || it.id || '')
    return makeSong({
      source: 'mg',
      id,
      name: it.songName || it.title,
      singer: it.singerName || '',
      albumName: it.albumName || '',
      albumId: it.albumId,
      interval: it.duration ? Math.round(num(it.duration) / 1000) : 0,
      img: it.cover || it.albumPic || '',
      copyrightId: it.copyrightId,
    })
  })
  return { list, isEnd: list.length < size, total: list.length }
}

const PROVIDERS = {
  kw: searchKw,
  kg: searchKg,
  tx: searchTx,
  wy: searchWy,
  mg: searchMg,
}

const SUPPORTED = Object.keys(PROVIDERS)

function isSupported(source) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, source)
}

/**
 * 内置搜索
 * @returns {Promise<{list: object[], isEnd: boolean, total: number, error?: string}>}
 */
async function search(source, keyword, page = 1, size = 30) {
  const fn = PROVIDERS[source]
  if (!fn) return { list: [], isEnd: true, total: 0, error: '不支持的平台: ' + source }
  try {
    return await fn(keyword, page, size)
  } catch (e) {
    return { list: [], isEnd: true, total: 0, error: (e && e.message) || String(e) }
  }
}

module.exports = { search, isSupported, SUPPORTED }
