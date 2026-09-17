import { NextRequest, NextResponse } from 'next/server'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { logger } from '@/lib/logger'
import { resolveMusicInfoById } from '@/lib/db'
import {
  sanitizeFilename,
  buildFilenameFromMusicInfo,
} from '@/lib/server/download-utils'
import type { QualityType } from '@/lib/types/music'

/**
 * 判断某首歌「是否已经下载到 NAS」，已下载则返回本地播放地址。
 *
 * GET /api/local-music/resolve?uid=<source-songmid>
 *   → { local: true,  name, size, quality, url }
 *   → { local: false }
 *
 * 匹配原理（关键）：落盘时的文件名是后端用 buildFilenameFromMusicInfo(musicInfo, quality)
 * 生成并 sanitize 的，所以只要用**同一个函数**按 uid 反推候选文件名，再逐个查是否存在即可，
 * 不需要维护额外的映射表，也不需要碰数据库。
 *
 * 因为落盘时用的音质可能和当前播放音质不同，这里按「高音质优先」依次尝试：
 * flac24bit → flac → 320k → 128k。命中哪个用哪个。
 */
const MUSIC_DIR =
  process.env.MUSIC_DOWNLOAD_DIR || '/app/prisma/prisma/data/music'

const QUALITIES: QualityType[] = ['flac24bit', 'flac', '320k', '128k']

export async function GET(request: NextRequest) {
  try {
    await requireUser(request)

    const uid = new URL(request.url).searchParams.get('uid')
    if (!uid) {
      return NextResponse.json({ error: '缺少 uid 参数' }, { status: 400 })
    }

    // 只读查询 MusicInfo，不写数据库
    logger.info("\[local-music/resolve] 查询 uid=" + uid)
    const musicInfo = await resolveMusicInfoById(uid)
    if (!musicInfo) {
      logger.warn("\[local-music/resolve] 未找到 MusicInfo: " + uid)
      return NextResponse.json({ local: false, reason: 'no-music-info' }, { status: 404 })
    }
    logger.info("\[local-music/resolve] 查询 uid=" + uid)

    for (const quality of QUALITIES) {
      const name = sanitizeFilename(buildFilenameFromMusicInfo(musicInfo, quality))
      const filePath = path.join(MUSIC_DIR, name)
      const st = await stat(filePath).catch(() => null)
      if (st && st.isFile() && st.size > 0) {
        return NextResponse.json({
          local: true,
          name,
          size: st.size,
          quality,
          url: `/api/local-music/play?name=${encodeURIComponent(name)}`,
        })
      }
    }

    return NextResponse.json({ local: false })
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    logger.error('[local-music/resolve] 未预期错误:', error)
    return NextResponse.json({ error: '查询失败' }, { status: 500 })
  }
}
