import { NextRequest, NextResponse } from 'next/server'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { logger } from '@/lib/logger'
import { getDownloadStatus, markDownloaded, removeDownload, isDownloaded } from '@/lib/download-status'

/**
 * GET /api/download-status?uid=...
 * 查询单首歌的下载状态
 */
export async function GET(request: NextRequest) {
  try {
    await requireUser(request)
    const uid = request.nextUrl.searchParams.get('uid')
    
    if (uid) {
      return NextResponse.json({ downloaded: isDownloaded(uid) })
    }
    
    // 获取所有已下载的 uid
    const status = getDownloadStatus()
    return NextResponse.json({ uids: Object.keys(status.downloads) })
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    logger.error('[download-status] error:', error)
    return NextResponse.json({ error: '查询失败' }, { status: 500 })
  }
}

/**
 * POST /api/download-status
 * body: { uid, filename, quality }
 * 标记某首歌已下载
 */
export async function POST(request: NextRequest) {
  try {
    await requireUser(request)
    const body = await request.json().catch(() => ({}))
    const { uid, filename, quality } = body as { uid?: string; filename?: string; quality?: string }
    
    if (!uid || !filename || !quality) {
      return NextResponse.json({ error: '缺少必要参数' }, { status: 400 })
    }
    
    markDownloaded(uid, filename, quality)
    return NextResponse.json({ ok: true })
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    logger.error('[download-status POST] error:', error)
    return NextResponse.json({ error: '更新失败' }, { status: 500 })
  }
}

/**
 * DELETE /api/download-status?uid=...
 * 移除某首歌的下载记录
 */
export async function DELETE(request: NextRequest) {
  try {
    await requireUser(request)
    const uid = request.nextUrl.searchParams.get('uid')
    
    if (!uid) {
      return NextResponse.json({ error: '缺少 uid 参数' }, { status: 400 })
    }
    
    removeDownload(uid)
    return NextResponse.json({ ok: true })
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    logger.error('[download-status DELETE] error:', error)
    return NextResponse.json({ error: '删除失败' }, { status: 500 })
  }
}
