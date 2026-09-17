/**
 * 前端下载日志上报工具
 * 将下载过程的关键事件上报到服务端落盘
 */

/**
 * 上报一条下载日志到服务端
 */
export async function reportDownloadLog(
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
    // 网络失败时静默忽略，不影响下载流程
  }
}

/**
 * 下载开始日志
 */
export async function logDownloadStart(uid: string, quality: string): Promise<void> {
  await reportDownloadLog('info', `[download] 开始下载`, { uid, quality })
}

/**
 * 下载成功日志
 */
export async function logDownloadSuccess(uid: string, filename: string, size: number): Promise<void> {
  await reportDownloadLog('info', `[download] 下载成功`, { uid, filename, size })
}

/**
 * 下载失败日志
 */
export async function logDownloadFail(uid: string, quality: string, reason: string): Promise<void> {
  await reportDownloadLog('error', `[download] 下载失败`, { uid, quality, reason })
}

/**
 * 批量下载任务开始
 */
export async function logQueueStart(taskCount: number): Promise<void> {
  await reportDownloadLog('info', `[download-queue] 开始批量下载`, { taskCount })
}

/**
 * 批量下载任务进度
 */
export async function logQueueProgress(index: number, total: number, uid: string): Promise<void> {
  await reportDownloadLog('info', `[download-queue] 进度`, { index, total, uid })
}

/**
 * 批量下载完成
 */
export async function logQueueComplete(ok: number, failed: number, cancelled: boolean): Promise<void> {
  await reportDownloadLog('info', `[download-queue] 完成`, { ok, failed, cancelled })
}
