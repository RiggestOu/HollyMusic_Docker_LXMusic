/**
 * 合并歌单 API
 * POST /api/playlists/[id]/merge { sourcePlaylistId: number }
 * 将源歌单的所有歌曲添加到目标歌单（去重）
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { getPlaylistDetail, addSongsToPlaylist } from '@/lib/services/playlist-service'
import { logger } from '@/lib/logger'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireUser(request)
    const { id } = await params
    const targetPlaylistId = parseInt(id, 10)
    if (isNaN(targetPlaylistId)) {
      return NextResponse.json({ error: '无效的歌单 ID' }, { status: 400 })
    }

    const body = await request.json().catch(() => ({}))
    const sourcePlaylistId = body?.sourcePlaylistId
    if (!sourcePlaylistId || typeof sourcePlaylistId !== 'number') {
      return NextResponse.json({ error: '缺少源歌单 ID' }, { status: 400 })
    }

    // 获取源歌单的歌曲
    const sourceDetail = await getPlaylistDetail(sourcePlaylistId, user.username)
    if (!sourceDetail) {
      return NextResponse.json({ error: '源歌单不存在' }, { status: 404 })
    }

    // 获取目标歌单已有的歌曲 ID
    const targetDetail = await getPlaylistDetail(targetPlaylistId, user.username)
    if (!targetDetail) {
      return NextResponse.json({ error: '目标歌单不存在' }, { status: 404 })
    }

    // 找出需要添加的歌曲（去重）
    const existingSongIds = new Set(targetDetail.entries.map(e => e.songId))
    const songsToAdd = sourceDetail.entries
      .filter(e => !existingSongIds.has(e.songId))
      .map(e => e.songId)

    if (songsToAdd.length === 0) {
      return NextResponse.json({ success: true, added: 0, message: '所有歌曲已存在' })
    }

    // 添加歌曲
    await addSongsToPlaylist(targetPlaylistId, user.username, songsToAdd)
    logger.info(`[merge] merged ${songsToAdd.length} songs from ${sourcePlaylistId} to ${targetPlaylistId}`)

    return NextResponse.json({ success: true, added: songsToAdd.length })
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    logger.error('[merge] error:', error)
    return NextResponse.json({ error: '合并失败' }, { status: 500 })
  }
}
