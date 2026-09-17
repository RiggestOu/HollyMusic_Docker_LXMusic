/**
 * 移动歌曲 API
 * POST /api/playlists/[id]/move { fromPlaylistId: number, songIds: string[] }
 * 从源歌单移动歌曲到目标歌单（删除源，添加目标）
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { getPlaylistDetail, addSongsToPlaylist, removeSongsFromPlaylist } from '@/lib/services/playlist-service'
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
      return NextResponse.json({ error: '无效的目标歌单 ID' }, { status: 400 })
    }

    const body = await request.json().catch(() => ({}))
    const sourcePlaylistId = body?.fromPlaylistId
    const songIds = Array.isArray(body?.songIds) ? body.songIds.filter((s: unknown) => typeof s === 'string') : []

    if (!sourcePlaylistId || typeof sourcePlaylistId !== 'number') {
      return NextResponse.json({ error: '缺少源歌单 ID' }, { status: 400 })
    }
    if (songIds.length === 0) {
      return NextResponse.json({ error: '缺少歌曲 ID' }, { status: 400 })
    }

    // 获取源歌单
    const sourceDetail = await getPlaylistDetail(sourcePlaylistId, user.username)
    if (!sourceDetail) {
      return NextResponse.json({ error: '源歌单不存在' }, { status: 404 })
    }

    // 获取目标歌单
    const targetDetail = await getPlaylistDetail(targetPlaylistId, user.username)
    if (!targetDetail) {
      return NextResponse.json({ error: '目标歌单不存在' }, { status: 404 })
    }

    // 找出要移动的条目位置
    const entriesToRemove = sourceDetail.entries.filter((e: { songId: string }) => songIds.includes(e.songId))
    const positionsToRemove = entriesToRemove.map((e: { position: number }) => e.position)

    if (positionsToRemove.length === 0) {
      return NextResponse.json({ error: '未找到要移动的歌曲' }, { status: 404 })
    }

    // 从源歌单删除
    await removeSongsFromPlaylist(sourcePlaylistId, user.username, positionsToRemove)
    
    // 添加到目标歌单
    const songsToAdd = entriesToRemove.map(e => e.songId)
    await addSongsToPlaylist(targetPlaylistId, user.username, songsToAdd)

    logger.info(`[move] moved ${songsToAdd.length} songs from ${sourcePlaylistId} to ${targetPlaylistId}`)

    return NextResponse.json({ success: true, moved: songsToAdd.length })
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    logger.error('[move] error:', error)
    return NextResponse.json({ error: '移动失败' }, { status: 500 })
  }
}
