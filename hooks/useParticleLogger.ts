/**
 * useParticleLogger —— 自动把 [particle] 前缀的 console.warn/error 上报到服务端落盘。
 *
 * 用法：在 App.tsx 或根组件里调用一次即可，全局生效。
 * 同时也暴露 `reportParticleLog` 给需要主动上报的地方（如 ParticleScene）。
 */

import { useEffect, useRef } from 'react'

export interface ParticleLogEntry {
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  meta?: Record<string, unknown>
}

/** 缓存最近 N 条未发送的日志（网络失败时重发）。 */
const pendingBuffer: ParticleLogEntry[] = []
const BUFFER_SIZE = 50

let initialized = false

/** 主动上报一条日志（供外部调用，如 ParticleScene）。 */
export async function reportParticleLog(entry: ParticleLogEntry): Promise<void> {
  try {
    await fetch('/api/particle-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    })
  } catch {
    /* 网络失败时缓冲，稍后重试 */
    if (pendingBuffer.length < BUFFER_SIZE) {
      pendingBuffer.push(entry)
    }
  }
}

/** 尝试刷新缓冲区中未发送的日志。 */
async function flushBuffer(): Promise<void> {
  if (pendingBuffer.length === 0) return
  const batch = pendingBuffer.splice(0, pendingBuffer.length)
  try {
    await Promise.all(batch.map(reportParticleLog))
  } catch {
    /* 失败时保留 */
    pendingBuffer.unshift(...batch)
  }
}

/** 全局拦截 console.warn/error，自动上报 [particle] 前缀的日志。 */
function installGlobalInterceptor(): void {
  if (typeof window === 'undefined') return
  if ((window as any).__particleLoggerInstalled) return
  ;(window as any).__particleLoggerInstalled = true

  const origWarn = console.warn
  const origError = console.error

  console.warn = function (...args: unknown[]): void {
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')
    if (msg.includes('[particle]')) {
      void reportParticleLog({ level: 'warn', message: msg })
    }
    origWarn.apply(console, args)
  }

  console.error = function (...args: unknown[]): void {
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')
    if (msg.includes('[particle]')) {
      void reportParticleLog({ level: 'error', message: msg })
    }
    origError.apply(console, args)
  }
}

export function useParticleLogger() {
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    installGlobalInterceptor()

    // 页面 unload 时强制刷新缓冲区
    const onBeforeUnload = () => void flushBuffer()
    window.addEventListener('beforeunload', onBeforeUnload)

    // 周期性刷新（每 30s）
    flushTimerRef.current = setInterval(() => {
      if (pendingBuffer.length > 0) void flushBuffer()
    }, 30000)

    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      if (flushTimerRef.current) clearInterval(flushTimerRef.current)
    }
  }, [])
}

/** 供组件直接调用的上报函数（带版本信息）。 */
export function particleLog(
  level: ParticleLogEntry['level'],
  message: string,
  meta?: Record<string, unknown>,
): void {
  void reportParticleLog({ level, message, meta })
}
