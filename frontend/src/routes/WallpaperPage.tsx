/**
 * 桌面壁纸页（路由 `/wallpaper`）。
 *
 * 由 Tauri 外壳在独立窗口中加载并挂到 Windows 桌面壁纸层（WorkerW）。
 * 这一页没有任何侧栏 / 播控 / 路由守卫，只有粒子场景：
 *   · 频谱来自主窗口经 IPC 推送（`hm:spectrum`），不在此页重复分析音频；
 *   · 配置来自 `hm:config`（服务地址之外的渲染参数）；
 *   · 全屏应用遮挡桌面时收到 `hm:pause`，暂停渲染省 GPU。
 *
 * 与 Web 端的 `ParticlePanel` 共用同一个 `ParticleScene`，因此视觉与交互完全一致。
 */

import { useEffect, useRef, useState } from 'react'
import { ParticleScene } from '@/components/player/ParticleScene'
import { loadStoredPreset, subscribePresetChange } from '@/lib/client/particle/presets'
import {
  loadStoredCustomImage,
  subscribeCustomImage,
} from '@/lib/client/particle/custom-image'
import {
  desktopOn,
  fetchDesktopConfig,
  type DesktopConfig,
} from '@/lib/client/desktop-bridge'
import type { BackendPreference } from '@/lib/client/particle'

const SPECTRUM_BINS = 64

export function WallpaperPage() {
  // 频谱数组复用同一实例、原地写入：ParticleScene 每帧直接读它，无需触发 React 重渲染。
  const spectrum = useRef(new Uint8Array(SPECTRUM_BINS))
  const [config, setConfig] = useState<DesktopConfig | null>(null)
  const [paused, setPaused] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 视觉预设与主窗口共享：两窗口同源，共用一份 localStorage，
  // 因此主窗口切换预设时壁纸窗口能立即跟随（storage 事件 + 同页自定义事件）
  const [preset, setPreset] = useState(() => loadStoredPreset())
  // 自定义封面图片（与主窗口共享，上传/恢复后立即跟随）
  const [customImageUrl, setCustomImageUrl] = useState(() => loadStoredCustomImage())

  useEffect(() => {
    const stops = [
      desktopOn<number[] | null>('spectrum', detail => {
        if (!Array.isArray(detail)) return
        const target = spectrum.current
        for (let i = 0; i < target.length; i++) {
          target[i] = Math.max(0, Math.min(255, Math.round(detail[i] ?? 0)))
        }
      }),
      desktopOn<DesktopConfig | null>('config', detail => {
        if (detail) setConfig(detail)
      }),
      desktopOn<{ paused?: boolean } | null>('pause', detail => {
        setPaused(Boolean(detail?.paused))
      }),
      subscribePresetChange(setPreset),
      subscribeCustomImage(setCustomImageUrl),
    ]
    void fetchDesktopConfig().then(c => {
      if (c) setConfig(c)
    })
    return () => stops.forEach(stop => stop())
  }, [])

  return (
    <div className="h-screen w-screen overflow-hidden bg-[#08080c]">
      <ParticleScene
        remoteSpectrum={spectrum.current}
        isPlaying
        grid={config?.grid ?? 160}
        fps={config?.fps ?? 60}
        pointSize={config?.pointSize ?? 1}
        paused={paused}
        preference={(config?.backend ?? 'auto') as BackendPreference}
        preset={preset}
        coverUrl={customImageUrl}
        onError={setError}
      />
      {error ? (
        <div className="pointer-events-none fixed bottom-4 left-4 text-xs text-white/50">
          {error}
        </div>
      ) : null}
    </div>
  )
}
