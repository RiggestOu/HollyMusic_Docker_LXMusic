/**
 * 桌面端桥接层（零依赖）。
 *
 * 本项目不在前端引入 `@tauri-apps/api`，因此这里用两套最朴素的标准机制：
 *   · 前端 → Rust：Tauri 注入的全局 `window.__TAURI__.core.invoke()`
 *     （由 `src-tauri/tauri.conf.json` 的 `withGlobalTauri: true` 提供）
 *   · Rust → 前端：Rust 调用 `WebviewWindow::eval()` 派发标准 `CustomEvent`，
 *     事件名统一为 `hm:*`，用 `window.addEventListener` 即可接收。
 *
 * 好处：Web / 移动端完全没有这段逻辑（isDesktop() 为 false 时全部空转），
 * 桌面端也不需要额外的 npm 依赖。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const TAURI_EVENT_PREFIX = 'hm:'

/** 桌面端配置（与 src-tauri/src/config.rs 的 AppConfig 字段一一对应）。 */
export interface DesktopConfig {
  serverUrl: string
  wallpaperEnabled: boolean
  lyricsEnabled: boolean
  lyricsClickThrough: boolean
  wallpaperPaused: boolean
  backend: 'auto' | 'webgpu' | 'webgl2'
  grid: number
  fps: number
  pointSize: number
}

type TauriLike = {
  core?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> }
}

function tauri(): TauriLike | null {
  if (typeof window === 'undefined') return null
  const t = (window as any).__TAURI__ as TauriLike | undefined
  return t?.core?.invoke ? t : null
}

/** 是否运行在桌面端外壳内。Web / 移动端恒为 false。 */
export function isDesktop(): boolean {
  return tauri() !== null
}

/** 调用桌面端 IPC 命令；非桌面端返回 null（调用方需自行判空）。 */
export function desktopInvoke<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> | null {
  const t = tauri()
  if (!t?.core?.invoke) return null
  return t.core.invoke(cmd, args) as Promise<T>
}

/**
 * 监听 Rust 侧推送的事件（CustomEvent）。
 * 返回取消监听的函数。
 */
export function desktopOn<T>(name: string, handler: (detail: T) => void): () => void {
  const event = `${TAURI_EVENT_PREFIX}${name}`
  const listener = (e: Event) => handler((e as CustomEvent<T>).detail)
  window.addEventListener(event, listener as EventListener)
  return () => window.removeEventListener(event, listener as EventListener)
}

// ---------- 具体业务封装 ----------

/** 主窗口 → 桌面壁纸：推送实时频谱（0~255）。 */
export function pushSpectrum(spectrum: number[]): void {
  void desktopInvoke('send_audio_spectrum', { spectrum })
}

/** 主窗口 → 桌面歌词：推送播放状态（切歌 / 进度 / 播放暂停）。 */
export function pushPlaybackState(state: {
  uid?: string
  title?: string
  artist?: string
  position?: number
  duration?: number
  isPlaying?: boolean
}): void {
  void desktopInvoke('send_playback_state', state)
}

/** 读取桌面端配置。 */
export async function fetchDesktopConfig(): Promise<DesktopConfig | null> {
  const p = desktopInvoke<DesktopConfig>('get_config')
  return p ? await p : null
}

/** 写入桌面端配置。 */
export async function saveDesktopConfig(config: DesktopConfig): Promise<void> {
  const p = desktopInvoke('set_config', { config })
  if (p) await p
}

/** 桌面歌词鼠标穿透开关。 */
export function setLyricsClickThrough(enabled: boolean): void {
  void desktopInvoke('set_lyrics_click_through', { enabled })
}
