/**
 * 复制歌曲 API
 * POST /api/playlists/[id]/copy { fromPlaylistId: number, songIds: string[] }
 * 从源歌单复制歌曲到目标歌单（不删除源）
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

    // 过滤掉目标歌单已存在的歌曲
    const existingSongIds = new Set(targetDetail.entries.map(e => e.songId))
    const songsToAdd = songIds.filter((id: string) => !existingSongIds.has(id))

    if (songsToAdd.length === 0) {
      return NextResponse.json({ success: true, copied: 0, message: '所有歌曲已存在' })
    }

    // 添加歌曲
    await addSongsToPlaylist(targetPlaylistId, user.username, songsToAdd)
    logger.info(`[copy] copied ${songsToAdd.length} songs from ${sourcePlaylistId} to ${targetPlaylistId}`)

    return NextResponse.json({ success: true, copied: songsToAdd.length })
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    logger.error('[copy] error:', error)
    return NextResponse.json({ error: '复制失败' }, { status: 500 })
  }
}
