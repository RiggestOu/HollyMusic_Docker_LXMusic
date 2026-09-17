/**
 * 自动去重 API
 * POST /api/playlists/deduplicate
 * 清理同名歌单和重复歌曲
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { logger } from '@/lib/logger'
import { deduplicatePlaylists } from '@/lib/services/playlist-service'

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request)

    logger.info(`[deduplicate] 开始去重，user=${user.username}`)
    const result = await deduplicatePlaylists(user.username)

    logger.info(`[deduplicate] 完成：合并=${result.mergedPlaylists}，删除=${result.deletedPlaylists}，清除=${result.removedDuplicates}`)

    return NextResponse.json({
      ok: true,
      mergedPlaylists: result.mergedPlaylists,
      deletedPlaylists: result.deletedPlaylists,
      removedDuplicates: result.removedDuplicates,
    })
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    logger.error('[deduplicate] error:', error)
    return NextResponse.json({ error: '去重失败' }, { status: 500 })
  }
}
