/**
 * 批量删除歌单 API
 * POST /api/playlists/batch-delete { ids: number[] }
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { deletePlaylistsBatch } from '@/lib/services/playlist-service'
import { logger } from '@/lib/logger'

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request)
    const body = await request.json().catch(() => ({}))
    const ids = Array.isArray(body?.ids) ? body.ids.filter((n: unknown) => typeof n === 'number') : []

    if (ids.length === 0) {
      return NextResponse.json({ error: '缺少歌单 ID 列表' }, { status: 400 })
    }

    const deleted = await deletePlaylistsBatch(ids, user.username)
    logger.info(`[batch-delete] deleted ${deleted}/${ids.length} playlists by ${user.username}`)
    return NextResponse.json({ success: true, deleted })
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    logger.error('[batch-delete] error:', error)
    return NextResponse.json({ error: '批量删除失败' }, { status: 500 })
  }
}
