import { NextRequest, NextResponse } from 'next/server'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { logger } from '@/lib/logger'

/**
 * 播放 NAS 上已下载的音乐文件。
 *
 * GET /api/local-music/play?name=<文件名>
 *   - 支持 Range（拖动进度需要 206 + Accept-Ranges）
 *   - 只允许读取 MUSIC_DIR 内的文件
 *
 * 安全：
 *   · 先做 path.basename 归一：必须与原值完全一致，杜绝 ../ 穿越与绝对路径。
 *   · 再做路径前缀校验：解析后的真实路径必须仍在 MUSIC_DIR 之内。
 */
const MUSIC_DIR =
  process.env.MUSIC_DOWNLOAD_DIR || '/app/prisma/prisma/data/music'

function contentTypeOf(name: string): string {
  const ext = path.extname(name).toLowerCase()
  switch (ext) {
    case '.mp3': return 'audio/mpeg'
    case '.flac': return 'audio/flac'
    case '.wav': return 'audio/wav'
    case '.m4a': return 'audio/mp4'
    case '.ogg':
    case '.opus': return 'audio/ogg'
    case '.aac': return 'audio/aac'
    default: return 'application/octet-stream'
  }
}

export async function GET(request: NextRequest) {
  try {
    await requireUser(request)

    const name = new URL(request.url).searchParams.get('name')
    if (!name) {
      return NextResponse.json({ error: '缺少 name 参数' }, { status: 400 })
    }

    // 1) 归一化 + 拒绝穿越
    const safe = path.basename(name)
    if (!safe || safe !== name || safe === '.' || safe === '..') {
      return NextResponse.json({ error: '非法文件名' }, { status: 400 })
    }

    const filePath = path.join(MUSIC_DIR, safe)
    // 2) 前缀校验：必须仍在目录内
    if (path.dirname(path.resolve(filePath)) !== path.resolve(MUSIC_DIR)) {
      return NextResponse.json({ error: '非法文件名' }, { status: 400 })
    }

    const st = await stat(filePath).catch(() => null)
    if (!st || !st.isFile()) {
      return NextResponse.json({ error: '文件不存在' }, { status: 404 })
    }

    const type = contentTypeOf(safe)
    const range = request.headers.get('range')

    // 无 Range：整段返回
    if (!range) {
      const stream = Readable.toWeb(
        createReadStream(filePath)
      ) as ReadableStream<Uint8Array>
      return new NextResponse(stream, {
        status: 200,
        headers: {
          'Content-Type': type,
          'Content-Length': String(st.size),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'private, max-age=3600',
        },
      })
    }

    // 有 Range：解析并回 206
    const match = /bytes=(\d*)-(\d*)/.exec(range)
    if (!match) {
      return new NextResponse(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${st.size}` },
      })
    }
    const start = match[1] ? parseInt(match[1], 10) : 0
    const end = match[2] ? parseInt(match[2], 10) : st.size - 1
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= st.size) {
      return new NextResponse(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${st.size}` },
      })
    }
    const stream = Readable.toWeb(
      createReadStream(filePath, { start, end })
    ) as ReadableStream<Uint8Array>
    return new NextResponse(stream, {
      status: 206,
      headers: {
        'Content-Type': type,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${st.size}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=3600',
      },
    })
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    logger.error('[local-music/play] 未预期错误:', error)
    return NextResponse.json({ error: '播放失败' }, { status: 500 })
  }
}
