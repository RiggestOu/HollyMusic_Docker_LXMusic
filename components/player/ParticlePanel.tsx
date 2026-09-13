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

  const [size, setSize] = useState(1)
  const [density, setDensity] = useState(160)
  const [fps, setFps] = useState(60)
  const [backend, setBackend] = useState<BackendKind | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** 当前被滚轮操作的菜单项（鼠标悬停切换）。 */
  const [focused, setFocused] = useState<MenuKey>('size')

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
