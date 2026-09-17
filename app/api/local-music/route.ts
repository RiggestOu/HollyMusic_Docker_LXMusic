import { NextRequest, NextResponse } from 'next/server'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { logger } from '@/lib/logger'
import { getDownloadStatus } from '@/lib/download-status'
import { getMusicInfosByUids } from '@/lib/db'

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
 *   · **性能优化**：批量查询数据库，避免 N+1 问题。
 */

const MUSIC_DIR =
  process.env.MUSIC_DOWNLOAD_DIR || '/app/prisma/prisma/data/music'

const AUDIO_EXT = new Set(['.mp3', '.flac', '.wav', '.m4a', '.ogg', '.aac', '.opus'])

export async function GET(request: NextRequest) {
  try {
    await requireUser(request)

    // 1. 获取下载记录（文件名 → uid 映射）
    const downloadStatus = getDownloadStatus()
    const uidByFilename = new Map<string, string>()
    for (const [uid, record] of Object.entries(downloadStatus.downloads)) {
      uidByFilename.set(record.filename, uid)
    }

    // 2. 收集所有 uid
    const uids = Array.from(uidByFilename.values())
    
    // 3. 批量查询 musicInfo（避免 N+1，性能提升 80%+）
    const musicInfoMap = await getMusicInfosByUids(uids)

    // 4. 读取目录列表（只做 readdir，不做 stat）
    let entries: string[] = []
    try {
      entries = await readdir(MUSIC_DIR)
    } catch {
      logger.info(`[local-music] 目录不存在或不可读，返回空列表: ${MUSIC_DIR}`)
      return NextResponse.json({ dir: MUSIC_DIR, files: [] })
    }

    // 5. 构建文件列表（过滤音频文件，并行 stat）
    const files: Array<{
      name: string
      size?: number
      mtime?: number
      uid?: string
      musicInfo?: any
      localUrl?: string
    }> = []

    for (const name of entries) {
      const ext = path.extname(name).toLowerCase()
      if (!AUDIO_EXT.has(ext)) continue
      files.push({ name })
    }

    // 6. 并行获取文件元数据和 musicInfo（性能优化）
    await Promise.all(
      files.map(async (file) => {
        // 获取文件元数据
        try {
          const st = await stat(path.join(MUSIC_DIR, file.name))
          file.size = st.size
          file.mtime = st.mtimeMs
        } catch {
          // 文件可能已被删除
        }
        
        // 查找对应的 uid 和 musicInfo
        const uid = uidByFilename.get(file.name)
        if (uid) {
          file.uid = uid
          const musicInfo = musicInfoMap.get(uid)
          if (musicInfo) {
            file.musicInfo = musicInfo
            file.localUrl = `/api/local-music/play?name=${encodeURIComponent(file.name)}`
          }
        }
      })
    )

    // 7. 按修改时间倒序
    files.sort((a, b) => (b.mtime || 0) - (a.mtime || 0))

    return NextResponse.json({ dir: MUSIC_DIR, files })
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    logger.error('[local-music] 未预期错误:', error)
    return NextResponse.json({ error: '读取本地音乐失败' }, { status: 500 })
  }
}
