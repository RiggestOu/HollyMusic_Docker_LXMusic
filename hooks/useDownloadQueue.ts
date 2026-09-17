/**
 * 下载队列（串行）—— 供「歌单右键下载」「下载全部未下载歌曲」等批量场景共用。
 *
 * 设计：
 *   · **一次只下一首**：避免瞬间打满回源带宽与磁盘 IO，也避免被音源限流。
 *   · **已存在则跳过**：入队前可用 resolveLocal 判定，命中就不重复下载。
 *   · **失败不中断**：记录原因继续下一首，最后汇总。
 *   · **可取消**：下一首开始前检查取消标志。
 *
 * 音质：默认取该曲目支持的「最高质量」。types 来自歌曲 MusicInfo，
 * 依次尝试 flac24bit → flac → 320k → 128k，都不匹配时退回 320k。
 */

import { useCallback, useRef, useState } from 'react'
import { toast } from '@/lib/toast'
import type { QualityType } from '@/lib/types/music'

export interface DownloadTask {
  uid: string
  name: string
  /** 落盘音质（入队时按 types 选出的最高可用音质）。 */
  quality: string
  status: 'pending' | 'downloading' | 'done' | 'failed' | 'skipped'
  reason?: string
}

const QUALITY_PREFERENCE = ['flac24bit', 'flac', '320k', '128k'] as const

/** 从歌曲的 types 里挑最高可用音质。 */
export function pickHighestQuality(types?: unknown): QualityType {
  const list = Array.isArray(types) ? (types as unknown[]) : []
  for (const q of QUALITY_PREFERENCE) {
    if (list.some(t => String(t).toLowerCase() === q)) return q as QualityType
  }
  return '320k'
}

/** 日志上报工具 */
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

export function useDownloadQueue() {
  const [tasks, setTasks] = useState<DownloadTask[]>([])
  const [running, setRunning] = useState(false)
  const [doneCount, setDoneCount] = useState(0)
  const cancelRef = useRef(false)

  const patch = useCallback((uid: string, next: Partial<DownloadTask>) => {
    setTasks(prev => prev.map(t => (t.uid === uid ? { ...t, ...next } : t)))
  }, [])

  /** 判定本地是否已存在该歌（复用第 13 项的 resolve 接口）。 */
  /** 判定本地是否已存在该歌（复用第 13 项的 resolve 接口）。 */
  const resolveLocal = useCallback(async (uid: string): Promise<boolean> => {
    try {
      const url = `/api/local-music/resolve?uid=${encodeURIComponent(uid)}`
      console.debug('[resolveLocal] checking uid=', uid, 'url=', url)
      const res = await fetch(url)
      console.debug('[resolveLocal] uid=', uid, 'status=', res.status, 'ok=', res.ok)
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        console.warn('[resolveLocal] HTTP', res.status, 'uid=', uid, 'body=', text.slice(0, 100))
        return false
      }
      const data = (await res.json().catch(() => ({}))) as { local?: boolean; reason?: string }
      console.debug('[resolveLocal] uid=', uid, 'data=', JSON.stringify(data))
      // 关键：只有 local === true 才认为是已下载
      const isLocal = data.local === true
      console.info('[resolveLocal] uid=', uid, 'isLocal=', isLocal, 'data=', JSON.stringify(data))
      return isLocal
    } catch (e) {
      console.error('[resolveLocal] error uid=', uid, e)
      return false
    }
  }, [])

  /**
   * 入队（内部会跳过已存在的）。
   * @param items 待下载歌曲（uid + 名称 + 可选 types）
   * @returns 实际入队数量
   */
  const enqueue = useCallback(
    async (
      items: Array<{ uid: string; name?: string; types?: unknown }>,
      skipExisting = true
    ): Promise<number> => {
      console.log('[enqueue] items.length=', items.length, 'skipExisting=', skipExisting)
      const list: DownloadTask[] = []
      let skipped = 0
      let checked = 0
      for (const it of items) {
        if (!it?.uid) {
          console.warn('[enqueue] invalid item:', it)
          continue
        }
        checked++
        if (skipExisting) {
          const isLocal = await resolveLocal(it.uid)
          console.log('[enqueue] checked uid=', it.uid, 'isLocal=', isLocal, 'checked=', checked)
          if (isLocal) {
            skipped++
            continue
          }
        }
        // 同一 uid 不重复入队
        if (list.some(t => t.uid === it.uid)) continue
        list.push({
          uid: it.uid,
          name: it.name || it.uid,
          quality: pickHighestQuality(it.types),
          status: 'pending',
        })
      }
      console.log('[enqueue] total items=', items.length, 'enqueued=', list.length, 'skipped=', skipped)
      setTasks(list)
      setDoneCount(0)

      // 记录批量下载开始
      await reportDownloadLog('info', '[download-queue] 开始批量下载', { taskCount: list.length })

      return list.length
    },
    [resolveLocal]
  )

  const run = useCallback(async () => {
    setRunning(true)
    cancelRef.current = false
    let ok = 0
    let failed = 0

    for (let i = 0; i < tasks.length; i++) {
      if (cancelRef.current) break
      const task = tasks[i]
      patch(task.uid, { status: 'downloading' })

      // 记录单个任务开始
      await reportDownloadLog('info', '[download-queue] 开始下载任务', { uid: task.uid, quality: task.quality, index: i, total: tasks.length })

      try {
        const res = await fetch('/api/download-to-nas', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uid: task.uid, quality: task.quality }),
        })
        const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; filename?: string; size?: number }
        if (!res.ok || !data.ok) {
          throw new Error(data.error || `HTTP ${res.status}`)
        }
        patch(task.uid, { status: 'done' })
        ok++
        // 记录成功
        await reportDownloadLog('info', '[download-queue] 任务成功', { uid: task.uid, quality: task.quality, filename: data.filename, size: data.size })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        console.error(`[download-to-nas] 失败 uid=${task.uid} quality=${task.quality}: ${msg}`)
        patch(task.uid, { status: 'failed', reason: msg })
        failed++
        // 记录失败
        await reportDownloadLog('error', '[download-queue] 任务失败', { uid: task.uid, quality: task.quality, error: msg })
      }
      setDoneCount(i + 1)

      // 记录进度
      await reportDownloadLog('info', '[download-queue] 进度', { index: i + 1, total: tasks.length, ok, failed })
    }

    setRunning(false)
    const cancelled = cancelRef.current
    if (cancelled) {
      toast.error(`已取消：成功 ${ok} 首，失败 ${failed} 首`)
    } else if (failed === 0) {
      toast.success(`下载完成：共 ${ok} 首`)
    } else {
      toast.error(`完成：成功 ${ok} 首，失败 ${failed} 首`)
    }
    // 记录批量下载完成
    await reportDownloadLog('info', '[download-queue] 批量下载完成', { ok, failed, cancelled })
    return { ok, failed, cancelled }
  }, [tasks, patch])

  const cancel = useCallback(() => {
    cancelRef.current = true
  }, [])

  const clear = useCallback(() => {
    setTasks([])
    setDoneCount(0)
  }, [])

  return { tasks, running, doneCount, enqueue, run, cancel, clear, resolveLocal }
}
