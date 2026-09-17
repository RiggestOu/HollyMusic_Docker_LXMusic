/**
 * POST /api/particle-log  —— 客户端粒子诊断日志落盘接口
 *
 * 用途：粒子初始化（WebGPU/WebGL2 探测）和运行时报错会调用此接口，
 *       将日志追加写进磁盘文件 `/app/prisma/prisma/data/log/particle-{date}.log`，
 *       供用户出问题后直接把 log 文件发给我分析。
 *
 * 鉴权：沿用 requireUser，未登录返回 401。
 *       不写数据库，仅做磁盘追加。
 *
 * POST body:
 *   { level: 'info'|'warn'|'error'|'debug', message: string, meta?: Record<string,unknown> }
 *
 * GET /api/particle-log?date=YYYY-MM-DD  → 返回当日日志文件内容（文本/plain）
 */

import { NextRequest, NextResponse } from 'next/server'
import { mkdir, appendFile, readFile, stat, rm, readdir } from 'node:fs/promises'
import path from 'node:path'
import { requireUser, AuthError } from '@/lib/services/user-context'
import { logger } from '@/lib/logger'

const LOG_DIR = process.env.PARTICLE_LOG_DIR || '/app/prisma/prisma/data/log'
const LOG_RETENTION_DAYS = 2 // 日志保留天数

function logFilePath(dateStr: string): string {
  return path.join(LOG_DIR, `particle-${dateStr}.log`)
}

/** 把客户端传来的日志条目组装成一行，追加到当天文件。 */
async function appendLogEntry(
  level: string,
  message: string,
  meta: Record<string, unknown> | undefined,
): Promise<void> {
  const dateStr = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  const ts = new Date().toISOString()
  const metaStr = meta ? ' ' + JSON.stringify(meta) : ''
  const line = `[${ts}] [${level.toUpperCase()}] ${message}${metaStr}\n`

  await mkdir(LOG_DIR, { recursive: true })
  await appendFile(logFilePath(dateStr), line)
  
  // 清理超过保留天数的日志文件
  await cleanupOldLogs()
  
  // 同步写一份到服务端 logger，方便服务端自己排查
  if (level === 'error') logger.error(`[particle-log] ${message}`, meta)
  else if (level === 'warn') logger.warn(`[particle-log] ${message}`, meta)
  else logger.info(`[particle-log] ${message}`, meta)
}

/** 删除超过保留天数的日志文件 */
async function cleanupOldLogs(): Promise<void> {
  try {
    const now = Date.now()
    const retentionMs = LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000
    const files = await readdir(LOG_DIR)
    for (const file of files) {
      if (!file.startsWith('particle-') || !file.endsWith('.log')) continue
      const filePath = path.join(LOG_DIR, file)
      const stats = await stat(filePath)
      if (now - stats.mtimeMs > retentionMs) {
        await rm(filePath)
        logger.info(`[particle-log] 已清理过期日志: ${file}`)
      }
    }
  } catch (err) {
    logger.warn(`[particle-log] 清理日志失败:`, err)
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireUser(request)
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: '未登录' }, { status: 401 })
    throw e
  }

  let body: { level?: string; message?: string; meta?: Record<string, unknown> }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: '无效 JSON' }, { status: 400 })
  }

  const { level = 'info', message, meta } = body
  if (!message || typeof message !== 'string') {
    return NextResponse.json({ error: '缺少 message 字段' }, { status: 400 })
  }

  await appendLogEntry(level, message, meta)
  return NextResponse.json({ ok: true })
}

/**
 * GET /api/particle-log?date=YYYY-MM-DD
 * 返回当日日志文件（text/plain），方便前端下载。
 */
export async function GET(request: NextRequest) {
  try {
    await requireUser(request)
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: '未登录' }, { status: 401 })
    throw e
  }

  const dateStr = request.nextUrl.searchParams.get('date')
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return NextResponse.json({ error: 'date 参数格式必须是 YYYY-MM-DD' }, { status: 400 })
  }

  const filePath = logFilePath(dateStr)
  let content: string
  try {
    const buf = await readFile(filePath)
    content = buf.toString('utf-8')
  } catch {
    return NextResponse.json({ error: '该日期无日志' }, { status: 404 })
  }

  return new NextResponse(content, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="particle-${dateStr}.log"`,
    },
  })
}
