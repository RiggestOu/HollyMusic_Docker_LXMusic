/**
 * 下载 hook
 *
 * 架构（2026-08 重构）：
 *   用户点击 → 同步构造 /api/download?uid=...&quality=... → window.location.href
 *   浏览器收到 Content-Disposition: attachment 后启动原生下载管理器（进度/速度/续传）。
 *
 * 为什么不用 fetch + Blob + a.click()？
 *   从用户点击到 a.click() 中间经过 getMusicUrl + fetch + blob 多个 await，
 *   累计耗时容易超过浏览器 transient user activation 窗口（Chrome ~5s），
 *   activation 过期后程序触发的 a.click() 不被浏览器视为用户意图，
 *   下载被静默阻止——这是旧架构"API 200 但浏览器不下载"的根因。
 *
 *   window.location.href 是页面导航，不依赖 user activation。
 *   浏览器收到 attachment 响应自动触发下载，当前页面不跳转。
 *
 * 为什么前端不传 filename？
 *   后端 /api/download 的 uid 模式用 resolveMusicInfoById 拿到 DB 中的 MusicInfo，
 *   再用 buildFilenameFromMusicInfo 后端组装文件名。这样：
 *   - 文件名完全后端控制，消除"前端可控文件名"的攻击面
 *   - 前端 URL 极简：?uid=...&quality=...
 *   - 前端不需要 he 实体解码、stripHtml 等逻辑（DRY）
 *
 * 为什么不再前端调 getMusicUrl？
 *   后端 uid 模式内部用 audioServe.serve 的 upstreamUrlResolver 惰性获取直链，
 *   与 /api/audio 共享同一份磁盘缓存：
 *   - 播放过的歌已落盘 → 下载 0 回源秒下
 *   - 未播放过 → 边下边落盘，下次再下即命中
 *   - 多用户共享缓存
 *
 * 鉴权：受 requireUser 保护，未登录返回 401。
 *
 * 【2026-09-13 变更】下载目标改为 **NAS 服务端落盘**（POST /api/download-to-nas），
 * 不再是浏览器下载。落盘目录默认 /app/prisma/prisma/data/music，
 * 可用环境变量 MUSIC_DOWNLOAD_DIR 覆盖。该接口不写数据库，仅读取 MusicInfo。
 */

import { useState, useCallback } from 'react'
import { toast } from '@/lib/toast'
import type { QualityType } from '@/lib/types/music'

/**
 * 将下载路由返回的 HTTP 状态码映射为用户友好的错误消息。
 *
 * 与 app/api/download/route.ts 的差异化错误响应一一对应：
 * - 401 未登录（requireUser 拒绝）
 * - 403 域名白名单拒绝（url 模式）
 * - 404 uid 找不到 MusicInfo（uid 模式）
 * - 413 文件超过 500MB 上限（url 模式）
 * - 502 回源网络错误 / audioServe 上游错误
 * - 504 回源超时（30s，url 模式）
 */
function mapDownloadError(status: number): string {
  switch (status) {
    case 401: return '请先登录'
    case 403: return '该音源域名不在下载白名单'
    case 404: return '找不到歌曲信息，请重新搜索'
    case 413: return '文件过大，暂不支持下载'
    case 502: return '下载源不可用，请稍后重试'
    case 504: return '下载超时，请稍后重试'
    default:  return `下载失败 (${status})`
  }
}

export { mapDownloadError }

// ============================================================================
// 日志上报工具
// ============================================================================

async function reportDownloadLog(
  level: 'info' | 'warn' | 'error' | 'debug',
  message: string,
  meta?: Record<string, unknown>
): Promise<void> {
  try {
    await fetch('/api/particle-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level, message, meta }),
    })
  } catch {
    // 网络失败时静默忽略
  }
}

// ============================================================================
// hook
// ============================================================================

export interface DownloadArgs {
  /** 歌曲 uid（source-songmid），与 /api/audio 一致，后端据此解析 MusicInfo + 命中缓存 + 组装文件名 */
  uid: string
  /** 音质；调用方应传 resolveQuality(播放偏好, 歌曲types) 解析后的值，与播放 URL 音质一致。
   *  不传时后端默认 320k。刻意不套 codecCap：那是浏览器解码上限，下载存文件不受限。 */
  quality?: QualityType
}

export function useDownload() {
  const [downloading, setDownloading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /**
   * 下载 = 保存到 NAS 服务端目录（默认 /app/prisma/prisma/data/music）。
   *
   * 不再用 window.location.href 交给浏览器下载管理器 —— 那只会把文件落到用户自己的电脑。
   * 这里改为 POST /api/download-to-nas：服务端取流落盘，浏览器只收一个 JSON 结果。
   * 因为不再依赖「页面导航」，也就不存在 transient user activation 的顾虑。
   */
  const download = useCallback(async ({ uid, quality = '320k' }: DownloadArgs) => {
    setDownloading(true)
    setError(null)

    // 记录下载开始
    await reportDownloadLog('info', '[download] 开始下载', { uid, quality })

    try {
      const res = await fetch('/api/download-to-nas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid, quality }),
      })
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        filename?: string
        size?: number
        error?: string
      }
      if (!res.ok || !data.ok) {
        const msg = data.error || mapDownloadError(res.status)
        setError(msg)
        toast.error(msg)
        // 记录下载失败
        await reportDownloadLog('error', '[download] 下载失败', { uid, quality, error: msg, httpStatus: res.status })
        return
      }
      toast.success(`已保存到 NAS：${data.filename ?? '完成'}`)
      // 记录下载成功
      await reportDownloadLog('info', '[download] 下载成功', { uid, quality, filename: data.filename, size: data.size })
    } catch (e) {
      const msg = e instanceof Error ? e.message : '下载失败'
      setError(msg)
      toast.error(msg)
      // 记录网络错误
      await reportDownloadLog('error', '[download] 网络错误', { uid, quality, error: msg })
    } finally {
      setDownloading(false)
    }
  }, [])

  return { download, downloading, error }
}
