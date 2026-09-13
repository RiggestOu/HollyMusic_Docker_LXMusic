import { NextRequest, NextResponse } from 'next/server'
import { mkdir, readdir, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { logger } from '@/lib/logger'

/**
 * 粒子自定义图片（服务端磁盘存储，不写数据库）
 *
 * POST  body: { dataUrl: string }   // data:image/png;base64,....
 *   → { ok: true, name, url }
 * GET   ?name=<文件名>  → 图片本体（供 <img> 与粒子纹理使用）
 * DELETE ?name=<文件名> → 删除
 *
 * 目录：环境变量 PARTICLE_IMAGE_DIR，默认 /app/prisma/prisma/data/particle-images
 * 与音乐目录分开，避免混在一起；同样不写数据库。
 */

const IMAGE_DIR =
  process.env.PARTICLE_IMAGE_DIR || '/app/prisma/prisma/data/particle-images'

const ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp'])
const MAX_BYTES = 8 * 1024 * 1024

function safeName(name: string): string | null {
  const base = path.basename(name)
  if (!base || base !== name || base.startsWith('.')) return null
  if (!ALLOWED_EXT.has(path.extname(base).toLowerCase())) return null
  return base
}

export async function GET(request: NextRequest) {
  try {
    await requireUser(request)
    const name = new URL(request.url).searchParams.get('name')

    // 无 name → 列出全部自定义图片
    if (!name) {
      let files: string[] = []
      try {
        files = (await readdir(IMAGE_DIR)).filter(f => safeName(f) !== null)
      } catch {
        files = []
      }
      return NextResponse.json({ images: files })
    }

    const safe = safeName(name)
    if (!safe) return NextResponse.json({ error: '非法文件名' }, { status: 400 })
    const p = path.join(IMAGE_DIR, safe)
    const buf = await import('node:fs/promises')
      .then(m => m.readFile(p))
      .catch(() => null)
    if (!buf) return NextResponse.json({ error: '文件不存在' }, { status: 404 })
    const ext = path.extname(safe).toLowerCase()
    const type =
      ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
    return new NextResponse(new Uint8Array(buf), {
      status: 200,
      headers: { 'Content-Type': type, 'Cache-Control': 'private, max-age=86400' },
    })
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    logger.error('[particle-image] GET 未预期错误:', error)
    return NextResponse.json({ error: '读取失败' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireUser(request)

    const body = (await request.json()) as { dataUrl?: string }
    const dataUrl = body?.dataUrl || ''
    const m = /^data:(image\/(png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
    if (!m) {
      return NextResponse.json({ error: '仅支持 PNG / JPG / WebP 的 dataURL' }, { status: 400 })
    }
    const ext = m[2] === 'jpeg' || m[2] === 'jpg' ? '.jpg' : m[2] === 'webp' ? '.webp' : '.png'
    const buf = Buffer.from(m[3], 'base64')
    if (buf.length <= 0 || buf.length > MAX_BYTES) {
      return NextResponse.json({ error: '图片大小超出限制（8MB）' }, { status: 413 })
    }

    await mkdir(IMAGE_DIR, { recursive: true })
    const name = `particle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`
    await (await import('node:fs/promises')).writeFile(path.join(IMAGE_DIR, name), buf)

    logger.info(`[particle-image] 已保存 ${name} (${buf.length} bytes)`)
    return NextResponse.json({
      ok: true,
      name,
      url: `/api/particle-image?name=${encodeURIComponent(name)}`,
    })
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    logger.error('[particle-image] POST 未预期错误:', error)
    return NextResponse.json({ error: '上传失败' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  try {
    await requireUser(request)
    const name = new URL(request.url).searchParams.get('name')
    const safe = name ? safeName(name) : null
    if (!safe) return NextResponse.json({ error: '非法文件名' }, { status: 400 })
    await unlink(path.join(IMAGE_DIR, safe)).catch(() => {})
    return NextResponse.json({ ok: true })
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    return NextResponse.json({ error: '删除失败' }, { status: 500 })
  }
}
