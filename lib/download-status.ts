/**
 * 下载状态管理
 * 
 * 使用 JSON 文件记录每首歌曲的下载状态，存储在 prisma_data/DownloadStatus/downloaded.json
 * 
 * 文件格式：
 * {
 *   "downloads": {
 *     "uid": { "filename": "...", "quality": "320k", "downloadedAt": "..." }
 *   },
 *   "updatedAt": "ISO timestamp"
 * }
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs"
import path from "node:path"

const STATUS_DIR = process.env.DOWNLOAD_STATUS_DIR || "/app/prisma/prisma/data/DownloadStatus"
const STATUS_FILE = path.join(STATUS_DIR, "downloaded.json")
const MUSIC_DIR = process.env.MUSIC_DOWNLOAD_DIR || "/app/prisma/prisma/data/music"

interface DownloadRecord {
  filename: string
  quality: string
  downloadedAt: string
}

interface DownloadStatusData {
  downloads: Record<string, DownloadRecord>
  updatedAt: string | null
}

export function getDownloadStatus(): DownloadStatusData {
  try {
    if (!existsSync(STATUS_FILE)) {
      return { downloads: {}, updatedAt: null }
    }
    const content = readFileSync(STATUS_FILE, "utf-8")
    return JSON.parse(content) as DownloadStatusData
  } catch {
    return { downloads: {}, updatedAt: null }
  }
}

/** 验证下载记录中的文件是否仍然存在于磁盘 */
function verifyFileExists(record: DownloadRecord): boolean {
  try {
    const filePath = path.join(MUSIC_DIR, record.filename)
    const stat = statSync(filePath)
    return stat.isFile() && stat.size > 0
  } catch {
    return false
  }
}

export function isDownloaded(uid: string): boolean {
  const status = getDownloadStatus()
  if (!(uid in status.downloads)) return false
  // 验证文件是否真实存在
  return verifyFileExists(status.downloads[uid])
}

export function getDownloadedUids(): string[] {
  const status = getDownloadStatus()
  return Object.entries(status.downloads)
    .filter(([, record]) => verifyFileExists(record))
    .map(([uid]) => uid)
}

/**
 * 清理过期的下载记录（文件已被手动删除的情况）
 * @returns 被清理的记录数
 */
export function cleanupExpiredRecords(): number {
  const status = getDownloadStatus()
  let cleaned = 0
  for (const [uid, record] of Object.entries(status.downloads)) {
    if (!verifyFileExists(record)) {
      delete status.downloads[uid]
      cleaned++
    }
  }
  if (cleaned > 0) {
    status.updatedAt = new Date().toISOString()
    _saveStatus(status)
  }
  return cleaned
}

export function markDownloaded(uid: string, filename: string, quality: string): void {
  const status = getDownloadStatus()
  status.downloads[uid] = {
    filename,
    quality,
    downloadedAt: new Date().toISOString(),
  }
  status.updatedAt = new Date().toISOString()
  _saveStatus(status)
}

export function removeDownload(uid: string): void {
  const status = getDownloadStatus()
  delete status.downloads[uid]
  status.updatedAt = new Date().toISOString()
  _saveStatus(status)
}

function _saveStatus(status: DownloadStatusData): void {
  mkdirSync(STATUS_DIR, { recursive: true })
  writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2), "utf-8")
}
