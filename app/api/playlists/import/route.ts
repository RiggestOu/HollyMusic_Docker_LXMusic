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
  songs: ImportSong[]
}

interface ImportBody {
  playlists: ImportPlaylist[]
}

export async function POST(
  request: NextRequest
) {
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
      index++
      const name = (item.name || '').trim() || '导入的歌单'
      const songCount = Array.isArray(item.songs) ? item.songs.length : 0
      try {
        logger.info(`[import] (${index}/${totalPlaylists}) 歌单「${name}」开始处理，歌曲数=${songCount}`)

        // 1. 创建歌单
        const playlist = await createPlaylist(user.username, name)
        logger.info(`[import] (${index}/${totalPlaylists}) 歌单「${name}」创建成功，id=${playlist.id}`)

        // 2. 更新元数据
        const updates: { comment?: string; public?: boolean } = {}
        if (item.comment !== undefined) updates.comment = item.comment ?? undefined
        if (item.isPublic !== undefined) updates.public = item.isPublic
        if (Object.keys(updates).length > 0) {
          await updatePlaylistMeta(playlist.id, user.username, updates)
          logger.info(`[import] (${index}/${totalPlaylists}) 歌单「${name}」元数据已更新，fields=${Object.keys(updates).join(',')}`)
        }

        // 3. Up sert 所有 musicInfo（批量事务）
        const musicInfos = item.songs
          .filter(s => s.musicInfo)
          .map(s => s.musicInfo!)

        if (musicInfos.length > 0) {
          await upsertMusicInfosInTransaction(musicInfos)
          logger.info(`[import] (${index}/${totalPlaylists}) 歌单「${name}」musicInfo 批量 upsert 完成，条数=${musicInfos.length}`)
        }

        // 4. 添加歌曲到歌单
        const songIds = item.songs
          .filter(s => s.songId)
          .map(s => s.songId!)

        if (songIds.length > 0) {
          await addSongsToPlaylist(playlist.id, user.username, songIds)
          logger.info(`[import] (${index}/${totalPlaylists}) 歌单「${name}」添加歌曲完成，条数=${songIds.length}`)
        }

        created.push({ id: playlist.id, name, count: item.songs.length })
        logger.info(`[import] (${index}/${totalPlaylists}) 歌单「${name}」导入成功（id=${playlist.id}，入库歌曲=${item.songs.length}）`)
      } catch (err) {
        logger.error(`[import] (${index}/${totalPlaylists}) 歌单「${name}」导入失败，已处理歌曲数=${songCount}:`, err)
        failed.push({ name: item.name, error: err instanceof Error ? err.message : String(err) })
      }
    }

    logger.info(`[import] ===== 导入结束：user=${user.username}，成功=${created.length}，失败=${failed.length} =====` +
      (failed.length > 0 ? ` 失败歌单：${failed.map(f => f.name).join('、')}` : ''))

    return createSuccessResponse({ created, failed, totalCreated: created.length })
  } catch (err) {
    if (err instanceof AuthError) {
      return createErrorResponse('UNAUTHORIZED', err.message, 401)
    }
    logger.error('[api/playlists/import POST] error:', err)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, '导入失败', 500)
  }
}
