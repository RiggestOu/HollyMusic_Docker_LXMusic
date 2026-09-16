/**
 * ParticleSettingsPanel —— 粒子视觉预设 + 动效参数统一面板（标签页切换）。
 *
 * 右上角齿轮按钮打开，左侧是「视觉预设」标签页（13 个预设网格），
 * 右侧是「动效参数」标签页（8 个滑杆 1:1 还原 Mineradio）。
 * 点击外部 / Esc 关闭。
 */

import { useEffect, useState } from 'react'
import {
  PRESETS,
  PRESET_CHANGED_EVENT,
  clampPreset,
  loadStoredPreset,
  storePreset,
} from '@/lib/client/particle/presets'
import type { BackendPreference } from '@/lib/client/particle'
import { useFxSettingsStore, type FxSettings, DEFAULT_FX } from '@/lib/store/fx-settings-store'
import { SlidersHorizontal, Sparkles, RotateCcw, X, Cpu, AlignJustify, Layers, Type } from 'lucide-react'
import { LensPresetsPanel } from './LensPresetsPanel'

type Tab = 'preset' | 'fx' | 'lyrics'

interface SliderDef {
  key: keyof FxSettings
  label: string
  min: number
  max: number
  step: number
  desc: string
}

const SLIDERS: SliderDef[] = [
  { key: 'intensity', label: '律动强度', min: 0.1, max: 2.0, step: 0.01, desc: 'K = intensity × 1.6，驱动粒子位移与尺寸' },
  { key: 'speed', label: '运动速度', min: 0.05, max: 5.0, step: 0.01, desc: 't = uTime × speed，控制时间流速' },
  { key: 'depth', label: '画面景深', min: 0, max: 2.0, step: 0.01, desc: '浮雕强度（depth 纹理 → Z 轴起伏）' },
  { key: 'twist', label: '粒子扭曲', min: 0, max: 1.0, step: 0.01, desc: '滚筒类预设的视轴旋转形变' },
  { key: 'scatter', label: '离散感', min: 0, max: 1.0, step: 0.01, desc: '粒子沿径向随机外扩' },
  { key: 'bloom', label: '光晕强度', min: 0, max: 3.0, step: 0.01, desc: '粒子亮度倍率（默认 1.0）' },
  { key: 'edge', label: '轮廓高亮', min: 0, max: 3.0, step: 0.01, desc: '边缘纹理 G 通道 → 轮廓发光强度' },
  { key: 'bgFade', label: '背景压暗', min: 0, max: 2.0, step: 0.01, desc: '背景层（星河）透明度补量' },
]

type LyricsMode = 'tile' | 'plane' | 'single'

const MODE_META: Record<LyricsMode, { label: string; icon: typeof AlignJustify }> = {
  tile: { label: '平铺', icon: AlignJustify },
  plane: { label: '贴合粒子', icon: Layers },
  single: { label: '单行', icon: Type },
}

function loadLyricsMode(): LyricsMode {
  try {
    const v = localStorage.getItem('lyrics-display-mode')
    return v === 'plane' || v === 'single' ? v : 'tile'
  } catch {
    return 'tile'
  }
}

/**
 * 歌词显示模式变更广播。
 *
 * 真正持有 mode 状态并渲染歌词的是 LyricsPanel（它用 useState 惰性读 localStorage），
 * 本面板只是「入口」——不广播的话，这里改了 localStorage 对方也不会重新读取，
 * 表现为「切换任何模式都不生效」。
 */
export const LYRICS_MODE_CHANGED_EVENT = 'hm-lyrics-mode-changed'

function saveLyricsMode(m: LyricsMode) {
  try {
    localStorage.setItem('lyrics-display-mode', m)
  } catch {
    /* ignore */
  }
}

export function ParticleSettingsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('fx')
  const fx = useFxSettingsStore((s) => s.fx)
  const backendPreference = useFxSettingsStore((s) => s.backendPreference)
  const setBackendPreference = useFxSettingsStore((s) => s.setBackendPreference)
  const update = useFxSettingsStore((s) => s.update)
  const reset = useFxSettingsStore((s) => s.resetFx)
  const [preset, setPreset] = useState(() => loadStoredPreset())
  const [lyricsMode, setLyricsMode] = useState<LyricsMode>(loadLyricsMode)

  const applyPreset = (index: number) => {
    const next = clampPreset(index)
    setPreset(next)
    storePreset(next)
    window.dispatchEvent(new Event(PRESET_CHANGED_EVENT))
  }

  // Esc 关闭
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <>
      {/* 半透明点击层：点外部 → 收起 */}
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* 右侧抽屉 */}
      <aside
        className="fixed right-0 top-0 z-50 flex h-full w-[min(340px,85vw)] flex-col border-l border-border bg-card shadow-2xl"
        role="dialog"
        aria-label="粒子设置"
      >
        {/* 顶栏 */}
        <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-semibold">粒子设置</span>
          </div>
          <button
            onClick={onClose}
            className="touch-target flex items-center justify-center rounded-full p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
            aria-label="关闭粒子设置"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 标签页切换 */}
        <div className="flex shrink-0 border-b border-border px-4">
          {([['fx', '动效参数'], ['preset', '视觉预设'], ['lyrics', '歌词显示']] as [Tab, string][]).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`flex-1 border-b-2 px-3 py-2.5 text-xs font-medium transition ${
                tab === k
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* 后端选择器（仅在动效参数标签页显示） */}
        {tab === 'fx' && (
          <div className="shrink-0 border-b border-border px-4 py-3">
            <div className="flex items-center gap-2">
              <Cpu className="h-4 w-4 text-muted-foreground" />
              <span className="text-xs font-medium text-muted-foreground">渲染后端</span>
              <div className="ml-auto flex gap-1">
                {(['auto', 'webgpu', 'webgl2'] as BackendPreference[]).map((pref) => (
                  <button
                    key={pref}
                    onClick={() => setBackendPreference(pref)}
                    className={`rounded px-2 py-1 text-[11px] transition ${
                      backendPreference === pref
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-muted-foreground hover:bg-muted-foreground/20'
                    }`}
                  >
                    {pref === 'auto' ? '自动' : pref === 'webgpu' ? 'WebGPU' : 'WebGL'}
                  </button>
                ))}
              </div>
            </div>
            <p className="mt-1 text-[10px] text-muted-foreground/60">
              {backendPreference === 'auto' && '自动检测（推荐）：优先 WebGPU，不支持时降级 WebGL'}
              {backendPreference === 'webgpu' && '强制 WebGPU：若浏览器不支持会尝试降级，请在控制台查看日志'}
              {backendPreference === 'webgl2' && '强制 WebGL 2.0：绕过 WebGPU 检测直接使用该后端'}
            </p>
          </div>
        )}

        {/* 内容区 */}
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {tab === 'fx' && (
            <div className="space-y-4">
              {SLIDERS.map((s) => (
                <div key={s.key}>
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-xs font-medium">{s.label}</span>
                    <span className="tabular-nums text-[11px] text-muted-foreground">
                      {Number(fx[s.key]).toFixed(2)}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={s.min}
                    max={s.max}
                    step={s.step}
                    value={fx[s.key]}
                    onChange={(e) => update({ [s.key]: Number(e.target.value) })}
                    className="w-full accent-primary"
                    aria-label={s.label}
                  />
                  <p className="mt-0.5 text-[10px] leading-tight text-muted-foreground/70">
                    {s.desc}
                  </p>
                </div>
              ))}
            </div>
          )}

          {tab === 'preset' && (
            <div className="grid grid-cols-2 gap-1.5">
              {PRESETS.map((item) => (
                <button
                  key={item.key}
                  onClick={() => applyPreset(item.id)}
                  title={item.hint}
                  aria-pressed={preset === item.id}
                  className={`rounded-md px-2 py-2 text-left text-[11px] leading-tight transition ${
                    preset === item.id
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                  }`}
                >
                  {item.label}
                  <span className="ml-1 text-[10px] opacity-60">#{item.id + 1}</span>
                </button>
              ))}
            </div>
          )}

          {tab === 'lyrics' && (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">选择歌词显示方式</p>
              <div className="grid grid-cols-3 gap-2">
                {(Object.entries(MODE_META) as [LyricsMode, typeof MODE_META['tile']][]).map(
                  ([mode, meta]) => (
                    <button
                      key={mode}
                      onClick={() => {
                        setLyricsMode(mode)
                        saveLyricsMode(mode)
                        // 关键：真正生效的 mode 状态在 LyricsPanel 里（它从 localStorage 惰性初始化），
                        // 本面板只是入口。必须广播，否则「任何模式都不生效」。
                        if (typeof window !== 'undefined') {
                          window.dispatchEvent(new Event(LYRICS_MODE_CHANGED_EVENT))
                        }
                      }}
                      className={`flex flex-col items-center gap-1.5 rounded-lg border px-3 py-3 text-xs transition ${
                        lyricsMode === mode
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border text-muted-foreground hover:bg-accent'
                      }`}
                    >
                      <meta.icon className="h-5 w-5" />
                      <span>{meta.label}</span>
                    </button>
                  )
                )}
              </div>
            </div>
          )}
        </div>

        {/* 镜头预设管理面板 */}
        <LensPresetsPanel
          visualPreset={PRESETS[preset]?.key ?? 'silk'}
          lyricsMode={lyricsMode}
          cameraState={{ theta: 0, phi: Math.PI / 2, radius: 6.6, target: [0, 0, 0] }}
        />

        {/* 底栏：重置 */}
        <div className="shrink-0 border-t border-border px-4 py-3">
          <button
            onClick={reset}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            恢复出厂默认
          </button>
        </div>
      </aside>
    </>
  )
}
