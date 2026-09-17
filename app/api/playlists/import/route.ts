/**
 * 导入歌单 API
 * POST /api/playlists/import
 * Body: { playlists: [{ name, comment, isPublic, songs: [{ songId, musicInfo }] }] }
 */

import { NextRequest } from 'next/server'
import { createSuccessResponse, createErrorResponse, ErrorCodes } from '@/lib/api-response'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { createPlaylist, updatePlaylistMeta, addSongsToPlaylist } from '@/lib/services/playlist-service'
import { upsertMusicInfosInTransaction } from '@/lib/db'
import { logger } from '@/lib/logger'

interface ImportSong {
  songId: string
  musicInfo: import('@/lib/types/music').MusicInfo
}

interface ImportPlaylist {
  name: string
  comment?: string | null
  isPublic?: boolean
  coverArt?: string | null
  songs: ImportSong[]
}

interface ImportBody {
  playlists: ImportPlaylist[]
}

// 最大导入时间（毫秒）：超时则返回部分结果
const MAX_IMPORT_MS = 5 * 60 * 1000 // 5 分钟
const BATCH_SIZE = 200 // 每批处理 songId 数量

export async function POST(
  request: NextRequest
) {
  const startTime = Date.now()
  const timeoutCheck = async () => {
    if (Date.now() - startTime > MAX_IMPORT_MS) {
      throw new Error(`导入超时（>${MAX_IMPORT_MS / 1000}s），已处理部分数据`)
    }
  }

  try {
    const user = await requireUser(request)
    const body = await request.json().catch(() => ({})) as ImportBody

    if (!Array.isArray(body.playlists)) {
      logger.warn('[import] 参数不合法：playlists 应为数组，user:', user.username)
      return createErrorResponse(ErrorCodes.INVALID_PARAMS, 'playlists 应为数组', 400)
    }

    const totalPlaylists = body.playlists.length
    const totalSongs = body.playlists.reduce((n, p) => n + (Array.isArray(p.songs) ? p.songs.length : 0), 0)
    logger.info(`[import] ===== 开始导入：user=${user.username}，歌单数=${totalPlaylists}，歌曲总数=${totalSongs} =====`)

    const created = []
    const failed = []
    let index = 0

    for (const item of body.playlists) {
      await timeoutCheck()
      index++
      const name = (item.name || '').trim() || '导入的歌单'
      const songCount = Array.isArray(item.songs) ? item.songs.length : 0
      try {
        logger.info(`[import] (${index}/${totalPlaylists}) 歌单「${name}」开始处理，歌曲数=${songCount}`)

        // 1. 创建歌单
        const playlist = await createPlaylist(user.username, name)
        logger.info(`[import] (${index}/${totalPlaylists}) 歌单「${name}」创建成功，id=${playlist.id}`)

        // 2. 更新元数据（含封面）
        const updates: { comment?: string; public?: boolean; coverArt?: string | null } = {}
        if (item.comment !== undefined) updates.comment = item.comment ?? undefined
        if (item.isPublic !== undefined) updates.public = item.isPublic
        if (item.coverArt) updates.coverArt = item.coverArt
        if (Object.keys(updates).length > 0) {
          await updatePlaylistMeta(playlist.id, user.username, updates)
          logger.info(`[import] (${index}/${totalPlaylists}) 歌单「${name}」元数据已更新，fields=${Object.keys(updates).join(',')}`)
        }

        // 3. Upsert 所有 musicInfo（分批处理，每批 200 条）
        const musicInfos = item.songs
          .filter(s => s.musicInfo)
          .map(s => s.musicInfo!)

        if (musicInfos.length > 0) {
          for (let i = 0; i < musicInfos.length; i += BATCH_SIZE) {
            await timeoutCheck()
            const batch = musicInfos.slice(i, i + BATCH_SIZE)
            await upsertMusicInfosInTransaction(batch)
            logger.info(`[import] (${index}/${totalPlaylists}) musicInfo upsert ${i + 1}-${Math.min(i + BATCH_SIZE, musicInfos.length)}/${musicInfos.length}`)
          }
          logger.info(`[import] (${index}/${totalPlaylists}) 歌单「${name}」musicInfo 批量 upsert 完成，条数=${musicInfos.length}`)
        }

        // 4. 添加歌曲到歌单（分批处理，每批 200 条）
        const songIds = item.songs
          .filter(s => s.songId)
          .map(s => s.songId!)

        if (songIds.length > 0) {
          for (let i = 0; i < songIds.length; i += BATCH_SIZE) {
            await timeoutCheck()
            const batch = songIds.slice(i, i + BATCH_SIZE)
            await addSongsToPlaylist(playlist.id, user.username, batch)
            logger.info(`[import] (${index}/${totalPlaylists}) 添加歌曲 ${i + 1}-${Math.min(i + BATCH_SIZE, songIds.length)}/${songIds.length}`)
          }
          logger.info(`[import] (${index}/${totalPlaylists}) 歌单「${name}」添加歌曲完成，条数=${songIds.length}`)
        }

        created.push({ id: playlist.id, name, count: item.songs.length })
        logger.info(`[import] (${index}/${totalPlaylists}) 歌单「${name}」导入成功（id=${playlist.id}，入库歌曲=${item.songs.length}）`)
      } catch (err) {
        logger.error(`[import] (${index}/${totalPlaylists}) 歌单「${name}」导入失败，已处理歌曲数=${songCount}:`, err)
        failed.push({ name: item.name, error: err instanceof Error ? err.message : String(err) })
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    logger.info(`[import] ===== 导入结束：user=${user.username}，成功=${created.length}，失败=${failed.length}，耗时 ${elapsed}s =====` +
      (failed.length > 0 ? ` 失败歌单：${failed.map(f => f.name).join('、')}` : ''))

    return createSuccessResponse({ created, failed, totalCreated: created.length, elapsedSec: Number(elapsed) })
  } catch (err) {
    if (err instanceof AuthError) {
      return createErrorResponse('UNAUTHORIZED', err.message, 401)
    }
    logger.error('[api/playlists/import POST] error:', err)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, '导入失败', 500)
  }
}
