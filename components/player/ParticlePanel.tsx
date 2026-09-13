/**
 * ParticlePanel —— 左下角按钮弹出的全屏粒子界面。
 *
 * 与 LyricsPanel 同层（z-50 全屏），但内容替换为粒子场景。
 * 左下角按钮不再弹出歌词；歌词仍可通过其它入口访问（见 LyricsPanel）。
 *
 * 交互约定（详见 ParticleScene）：
 *   · PC：滚轮 → 调节菜单滑块（不控制镜头）；Alt+中键旋转 / Alt+右键推拉 / 中键平移
 *   · 移动端：单指旋转 / 双指平移 / 三指推拉
 *
 * 本面板只做「界面壳」：参数状态 + 菜单渲染 + 滚轮派发，渲染逻辑全在 ParticleScene。
 */

import { useCallback, useEffect, useState } from 'react'
import { X, Sparkles } from 'lucide-react'
import { ParticleScene } from './ParticleScene'
import type { BackendKind } from '@/lib/client/particle/types'
import {
  PRESETS,
  PRESET_CHANGED_EVENT,
  clampPreset,
  loadStoredPreset,
  storePreset,
} from '@/lib/client/particle/presets'
import {
  loadAiDepthEnabled,
  setAiDepthEnabled,
} from '@/lib/client/particle/cover-depth-ai'
import { useRef } from 'react'
import {
  loadStoredCustomImage,
  storeCustomImage,
} from '@/lib/client/particle/custom-image'
import { buildCoverUrl } from '@/lib/api/music'
import { usePlayerStore } from '@/lib/store/player-store'

interface ParticlePanelProps {
  audio: HTMLAudioElement | null
}

/** 可滚轮调节的菜单项。 */
const MENU_ITEMS = [
  { key: 'size', label: '粒子大小', min: 0.4, max: 2.5, step: 0.05 },
  { key: 'density', label: '粒子密度', min: 80, max: 220, step: 10 },
  { key: 'fps', label: '帧率上限', min: 24, max: 120, step: 2 },
  { key: 'volume', label: '音量', min: 0, max: 1, step: 0.02 },
] as const

type MenuKey = (typeof MENU_ITEMS)[number]['key']

const BACKEND_LABEL: Record<BackendKind, string> = {
  webgpu: 'WebGPU',
  webgl2: 'WebGL 2.0',
}

export function ParticlePanel({ audio }: ParticlePanelProps) {
  const isOpen = usePlayerStore(s => s.isParticleOpen)
  const setParticleOpen = usePlayerStore(s => s.setParticleOpen)
  const volume = usePlayerStore(s => s.volume)
  const setVolume = usePlayerStore(s => s.setVolume)
  const isPlaying = usePlayerStore(s => s.isPlaying)
  const currentTrack = usePlayerStore(s => s.currentTrack)

  const [size, setSize] = useState(1)
  const [density, setDensity] = useState(160)
  const [fps, setFps] = useState(60)
  const [preset, setPreset] = useState(() => loadStoredPreset())
  const [aiDepth, setAiDepth] = useState(() => loadAiDepthEnabled())
  // 自定义图片（第 5 项）：设置后优先生效，清空后回到当前曲目封面
  const [customImageUrl, setCustomImageUrl] = useState<string | null>(
    () => loadStoredCustomImage()
  )
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [backend, setBackend] = useState<BackendKind | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** 当前被滚轮操作的菜单项（鼠标悬停切换）。 */
  const [focused, setFocused] = useState<MenuKey>('size')

  /** 当前曲目封面 URL（cacheKey 用 musicInfo.img，音源换图时缓存键随之变化）。 */
  const coverUrl =
    customImageUrl ??
    (currentTrack ? buildCoverUrl(currentTrack.uid, currentTrack.musicInfo.img) : null)

  /**
   * 切换预设：更新状态 + 落盘 + 广播。
   * 落盘是为了让桌面壁纸窗口也能记住同一预设（两个窗口同源，共享 localStorage）；
   * 广播用于同页即时通知。
   */
  /** 上传自定义图片 → 服务端落盘 → 作为粒子封面使用。 */
  const handleCustomImage = useCallback(async (file: File) => {
    setUploading(true)
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(new Error('读取文件失败'))
        reader.readAsDataURL(file)
      })
      const res = await fetch('/api/particle-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataUrl }),
      })
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string }
      if (!res.ok || !data.url) throw new Error(data.error || `HTTP ${res.status}`)
      setCustomImageUrl(data.url)
      storeCustomImage(data.url)
    } catch (e) {
      const msg = e instanceof Error ? e.message : '上传失败'
      setError(msg)
    } finally {
      setUploading(false)
    }
  }, [])

  const applyPreset = useCallback((index: number) => {
    const next = clampPreset(index)
    setPreset(next)
    storePreset(next)
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event(PRESET_CHANGED_EVENT))
    }
  }, [])

  // Esc 关闭（与 LyricsPanel 一致的键盘退出路径）
  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setParticleOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, setParticleOpen])

  const valueOf = useCallback(
    (key: MenuKey) => (key === 'size' ? size : key === 'density' ? density : key === 'fps' ? fps : volume),
    [size, density, fps, volume],
  )

  const setValue = useCallback(
    (key: MenuKey, v: number) => {
      if (key === 'size') setSize(v)
      else if (key === 'density') setDensity(Math.round(v))
      else if (key === 'fps') setFps(Math.round(v))
      else setVolume(v)
    },
    [setVolume],
  )

  /** 滚轮：向上增大、向下减小当前聚焦项。 */
  const handleWheelMenu = useCallback(
    (deltaY: number) => {
      const item = MENU_ITEMS.find(i => i.key === focused)
      if (!item) return
      const dir = deltaY > 0 ? -1 : 1
      const next = valueOf(item.key) + dir * item.step
      setValue(item.key, Math.min(item.max, Math.max(item.min, next)))
    },
    [focused, valueOf, setValue],
  )

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-[#08080C] text-foreground"
      role="dialog"
      aria-modal="true"
      aria-label="粒子界面"
    >
      {/* 顶部：关闭按钮 + 后端标识 */}
      <div className="safe-area-top pointer-events-none flex h-14 shrink-0 items-center justify-between px-3">
        <button
          onClick={() => setParticleOpen(false)}
          className="touch-target pointer-events-auto flex items-center justify-center rounded-full text-muted-foreground transition hover:bg-accent hover:text-foreground"
          aria-label="收起粒子界面"
        >
          <X className="h-6 w-6" />
        </button>
        <div className="pointer-events-none flex items-center gap-2 text-xs text-muted-foreground">
          <Sparkles className="h-4 w-4" />
          <span>{backend ? BACKEND_LABEL[backend] : '初始化中…'}</span>
        </div>
      </div>

      {/* 粒子场景：占据主要区域，交互在其 canvas 上 */}
      <div className="relative min-h-0 flex-1">
        <ParticleScene
          audio={audio}
          isPlaying={isPlaying}
          coverUrl={coverUrl}
          preset={preset}
          grid={density}
          fps={fps}
          pointSize={size}
          onWheelMenu={handleWheelMenu}
          onBackend={setBackend}
          onError={setError}
          className="absolute inset-0"
        />

        {error ? (
          <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-muted-foreground">
            {error}
          </div>
        ) : null}

        {/* 参数菜单：滚轮作用于当前悬停项 */}
        <div className="safe-area-bottom absolute right-3 top-3 w-56 rounded-xl border border-border bg-card/85 p-3 shadow-lg backdrop-blur">
          <div className="mb-2 flex items-center justify-between text-xs font-medium text-muted-foreground">
            <span>视觉预设</span>
            <span className="tabular-nums text-[10px] opacity-70">
              {preset + 1}/{PRESETS.length}
            </span>
          </div>
          <div className="mb-3 grid max-h-52 grid-cols-2 gap-1 overflow-y-auto pr-0.5">
            {PRESETS.map(item => (
              <button
                key={item.key}
                onClick={() => applyPreset(item.id)}
                title={item.hint}
                aria-pressed={preset === item.id}
                className={`rounded-md px-1.5 py-1 text-left text-[11px] leading-tight transition ${
                  preset === item.id
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
          {/* 第 5 项：上传自定义图片作为粒子封面 */}
          <div className="mb-3 rounded-lg bg-background/60 p-2">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[11px] text-muted-foreground">自定义封面图片</span>
              {customImageUrl ? (
                <button
                  type="button"
                  onClick={() => {
                    setCustomImageUrl(null)
                    storeCustomImage(null)
                  }}
                  className="text-[11px] text-primary hover:underline"
                >
                  恢复封面
                </button>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="w-full rounded-md border border-border px-2 py-1.5 text-[11px] text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-60"
            >
              {uploading ? '上传中…' : '选择图片上传到服务端'}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={e => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (f) void handleCustomImage(f)
              }}
            />
          </div>
          <label className="mb-3 flex cursor-pointer items-start gap-2 rounded-lg bg-background/60 px-2 py-1.5">
            <input
              type="checkbox"
              checked={aiDepth}
              onChange={e => {
                setAiDepth(e.target.checked)
                setAiDepthEnabled(e.target.checked)
              }}
              className="mt-0.5"
            />
            <span className="text-[11px] leading-tight text-muted-foreground">
              AI 深度增强
              <span className="block opacity-70">首次使用需从 CDN 下载约 50MB 模型，失败自动回退</span>
            </span>
          </label>
          <div className="mb-2 text-xs font-medium text-muted-foreground">
            滚轮调节（悬停选择）
          </div>
          <div className="space-y-3">
            {MENU_ITEMS.map(item => {
              const v = valueOf(item.key)
              const active = focused === item.key
              return (
                <div
                  key={item.key}
                  onMouseEnter={() => setFocused(item.key)}
                  onFocus={() => setFocused(item.key)}
                  className={active ? 'opacity-100' : 'opacity-60'}
                >
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span>{item.label}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {item.key === 'volume' ? Math.round(v * 100) : v}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={item.min}
                    max={item.max}
                    step={item.step}
                    value={v}
                    onChange={e => setValue(item.key, Number(e.target.value))}
                    onMouseEnter={() => setFocused(item.key)}
                    className="w-full accent-primary"
                    aria-label={item.label}
                  />
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
