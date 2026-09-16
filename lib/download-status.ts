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

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const STATUS_DIR = process.env.DOWNLOAD_STATUS_DIR || '/app/prisma/prisma/data/DownloadStatus'
const STATUS_FILE = path.join(STATUS_DIR, 'downloaded.json')

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
    const content = readFileSync(STATUS_FILE, 'utf-8')
    return JSON.parse(content) as DownloadStatusData
  } catch {
    return { downloads: {}, updatedAt: null }
  }
}

export function isDownloaded(uid: string): boolean {
  const status = getDownloadStatus()
  return uid in status.downloads
}

export function getDownloadedUids(): string[] {
  const status = getDownloadStatus()
  return Object.keys(status.downloads)
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
  writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2), 'utf-8')
}
