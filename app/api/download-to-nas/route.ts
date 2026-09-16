import { NextRequest, NextResponse } from 'next/server'
import { createWriteStream } from 'node:fs'
import { mkdir, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { logger } from '@/lib/logger'
import { resolveMusicInfoById } from '@/lib/db'
import { musicSourceManager } from '@/lib/music-source-manager'
import { audioServe } from '@/lib/audio-serve'
import { parseIntervalToSeconds } from '@/lib/types/player'
import { sanitizeFilename, buildFilenameFromMusicInfo } from '@/lib/server/download-utils'
import type { QualityType } from '@/lib/types/music'
import { markDownloaded } from '@/lib/download-status'

/**
 * 下载到 NAS（服务端落盘）
 *
 * 与 `/api/download` 的区别：
 *   · `/api/download`  → 以 attachment 响应给浏览器，文件落在**用户电脑**；
 *   · `/api/download-to-nas` → 服务端把音频写入**服务器目录**，浏览器只收到一个 JSON 结果。
 *
 * 设计要点：
 *   · **不写数据库**：只读取 MusicInfo（resolveMusicInfoById 为只读查询），不新增/修改任何表与字段，
 *     严格遵守 HollyMusic 数据库保护条款。
 *   · 复用 audioServe：cacheKey 与 /api/audio 完全一致 →
 *     播放过的歌命中磁盘缓存（0 回源）；未播放过则回源一次并边下边落盘，下次再下即命中。
 *   · 文件名由后端按 MusicInfo 组装（buildFilenameFromMusicInfo），不接受前端传入的文件名。
 *   · 目标目录默认 `/app/prisma/prisma/data/music`，可用环境变量 `MUSIC_DOWNLOAD_DIR` 覆盖。
 *   · 先写临时文件（.part），成功后重命名，避免中断留下半截文件。
 *
 * 鉴权：受 requireUser 保护，未登录返回 401。
 */

/** 服务端落盘目录（默认即用户指定的 NAS 音乐目录）。 */
const MUSIC_DIR =
  process.env.MUSIC_DOWNLOAD_DIR || '/app/prisma/prisma/data/music'

const VALID_QUALITIES: QualityType[] = ['128k', '320k', 'flac', 'flac24bit']

function getClientIP(request: NextRequest): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ip = (request as any).ip ?? request.headers.get('x-forwarded-for') ?? 'unknown'
  return typeof ip === 'string' ? ip.split(',')[0].trim() : 'unknown'
}

/**
 * POST /api/download-to-nas  body: { uid: string, quality?: QualityType }
 * 返回：{ ok: true, filename, size, path } 或 { error: string }
 */
export async function POST(request: NextRequest) {
  try {
    await requireUser(request)

    const body = (await request.json()) as { uid?: string; quality?: string }
    const uid = body?.uid
    if (!uid || typeof uid !== 'string') {
      return NextResponse.json({ error: '缺少或无效的 uid 参数' }, { status: 400 })
    }
    const quality = (body?.quality || '320k') as QualityType
    if (!VALID_QUALITIES.includes(quality)) {
      return NextResponse.json({ error: `不支持的音质: ${quality}` }, { status: 400 })
    }

    // 1. 只读解析 uid → MusicInfo
    const musicInfo = await resolveMusicInfoById(uid)
    if (!musicInfo) {
      return NextResponse.json({ error: `找不到歌曲信息: ${uid}` }, { status: 404 })
    }

    // 2. 与 /api/audio 一致的 cacheKey，命中同一份磁盘缓存
    const cacheKey = `${musicInfo.source}:${musicInfo.songmid}:${quality}`
    const upstreamUrlResolver = async (): Promise<string> => {
      if (!musicSourceManager.isInitialized()) {
        await musicSourceManager.initialize()
      }
      return musicSourceManager.getMusicUrl(musicInfo, quality)
    }

    await audioServe.ensureInitialized()

    // 3. 不传 Range → audioServe 返回 200 完整文件
    const audioResp = await audioServe.serve({
      cacheKey,
      upstreamUrlResolver,
      rangeHeader: null,
      isHead: false,
      intervalSec: parseIntervalToSeconds(musicInfo.interval),
    })

    if (!audioResp.ok || !audioResp.body) {
      logger.warn(`[download-to-nas] audioServe 返回 ${audioResp.status} uid=${uid}`)
      return NextResponse.json(
        { error: `音频源不可用 (${audioResp.status})` },
        { status: 502 }
      )
    }

    // 4. 后端组装文件名并落盘（先 .part 后重命名）
    const filename = sanitizeFilename(buildFilenameFromMusicInfo(musicInfo, quality))
    await mkdir(MUSIC_DIR, { recursive: true })
    const targetPath = path.join(MUSIC_DIR, filename)
    const tmpPath = `${targetPath}.part`

    try {
      await pipeline(
        Readable.fromWeb(audioResp.body as Parameters<typeof Readable.fromWeb>[0]),
        createWriteStream(tmpPath)
      )
      const info = await stat(tmpPath)
      if (info.size <= 0) throw new Error('写入文件为空')
      await unlink(targetPath).catch(() => {})
      const { rename } = await import('node:fs/promises')
      await rename(tmpPath, targetPath)

      logger.info(`[download-to-nas] ok uid=${uid} file=${filename} size=${info.size}`)
      // 记录下载状态
      markDownloaded(uid, filename, quality)
      return NextResponse.json({
        ok: true,
        filename,
        size: info.size,
        path: targetPath,
      })
    } catch (e) {
      await unlink(tmpPath).catch(() => {})
      const msg = e instanceof Error ? e.message : String(e)
      logger.error(`[download-to-nas] 写入失败 uid=${uid}: ${msg}`)
      return NextResponse.json({ error: `写入 NAS 失败: ${msg}` }, { status: 500 })
    }
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    logger.error('[download-to-nas] 未预期错误:', error)
    return NextResponse.json({ error: '下载失败' }, { status: 500 })
  }
}

/**
 * GET /api/download-to-nas?uid=...&quality=...
 * 便利入口（与 POST 同逻辑），便于在浏览器地址栏或简单场景调用。
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const uid = searchParams.get('uid')
  const quality = searchParams.get('quality') || '320k'
  const clientIP = getClientIP(request)

  if (uid) {
    // 复用 POST 逻辑：构造一个最小请求体
    const fake = new NextRequest(request.url, {
      method: 'POST',
      body: JSON.stringify({ uid, quality }),
      headers: request.headers,
    })
    return POST(fake)
  }

  logger.warn(`[download-to-nas] 缺少 uid ip=${clientIP}`)
  return NextResponse.json({ error: '缺少参数：需提供 uid' }, { status: 400 })
}
