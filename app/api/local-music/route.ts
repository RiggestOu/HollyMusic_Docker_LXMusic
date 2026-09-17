import { NextRequest, NextResponse } from 'next/server'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { logger } from '@/lib/logger'
import { getDownloadStatus } from '@/lib/download-status'
import { resolveMusicInfoById } from '@/lib/db'

/**
 * 本地音乐（NAS 落盘目录）浏览
 *
 * GET /api/local-music
 *   → { dir: string, files: Array<{ name, size, mtime, uid?, musicInfo?, localUrl? }> }
 *
 * 设计要点：
 *   · 与 /api/download-to-nas 共用同一个目录常量：环境变量 MUSIC_DOWNLOAD_DIR 优先，
 *     默认 /app/prisma/prisma/data/music。
 *   · **不写数据库**，只是列目录；遵守 HollyMusic 数据库保护条款。
 *   · 目录不存在 / 读取失败时返回空列表（而不是 500），避免首次部署时界面报错。
 *   · 只返回音频扩展名，按修改时间倒序（最新下载的在前）。
 *   · 鉴权沿用 requireUser，未登录 401。
 *   · **增强**：根据 downloaded.json 中的文件名→uid 映射，附加 musicInfo 信息，
 *     使前端能获取专辑封面、歌词、播放 URL 等完整数据。
 */

const MUSIC_DIR =
  process.env.MUSIC_DOWNLOAD_DIR || '/app/prisma/prisma/data/music'

const AUDIO_EXT = new Set(['.mp3', '.flac', '.wav', '.m4a', '.ogg', '.aac', '.opus'])

export async function GET(request: NextRequest) {
  try {
    await requireUser(request)

    let entries: string[] = []
    try {
      entries = await readdir(MUSIC_DIR)
    } catch {
      // 目录不存在（还没下载过任何歌）→ 视为空列表
      logger.info(`[local-music] 目录不存在或不可读，返回空列表: ${MUSIC_DIR}`)
      return NextResponse.json({ dir: MUSIC_DIR, files: [] })
    }

    // 加载下载记录（文件名 → uid 映射）
    const downloadStatus = getDownloadStatus()
    const uidByFilename = new Map<string, string>()
    for (const [uid, record] of Object.entries(downloadStatus.downloads)) {
      uidByFilename.set(record.filename, uid)
    }

    const files: Array<{
      name: string
      size: number
      mtime: number
      uid?: string
      musicInfo?: any
      localUrl?: string
    }> = []

    for (const name of entries) {
      const ext = path.extname(name).toLowerCase()
      if (!AUDIO_EXT.has(ext)) continue
      const st = await stat(path.join(MUSIC_DIR, name)).catch(() => null)
      if (!st || !st.isFile()) continue

      // 查找对应的 uid 和 musicInfo
      const uid = uidByFilename.get(name)
      let musicInfo = null
      let localUrl: string | undefined
      if (uid) {
        try {
          musicInfo = await resolveMusicInfoById(uid)
        } catch {
          // musicInfo 查询失败不影响文件列表展示
        }
        if (musicInfo) {
          localUrl = `/api/local-music/play?name=${encodeURIComponent(name)}`
        }
      }

      files.push({
        name,
        size: st.size,
        mtime: st.mtimeMs,
        uid: uid || undefined,
        musicInfo: musicInfo || undefined,
        localUrl,
      })
    }

    // 最新下载的排前面
    files.sort((a, b) => b.mtime - a.mtime)

    return NextResponse.json({ dir: MUSIC_DIR, files })
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    logger.error('[local-music] 未预期错误:', error)
    return NextResponse.json({ error: '读取本地音乐失败' }, { status: 500 })
  }
}
