/**
 * ParticleTuningPanel —— 独立的「实验调参」面板（debug 专用）。
 *
 * 与「设置」面板分开：仅在点击设置按钮**旁边的 debug 按钮**时打开，互不干扰。
 *
 * 背景：这些参数原本是硬编码在着色器里的常数，想确认「到底是哪个参数在影响观感」
 * 只能反复改代码 + 重新构建部署。现全部提升为 uniform 暴露在这里，实时可调。
 *
 * 用法：每项前面的开关默认打开；**关掉即按 0 下发**（原值保留，重开即恢复），
 * 因此可以从「全部归零」开始逐个打开，定位到底是哪一项在引起震动/变化。
 */

import { useEffect } from 'react'
import { TUNING_KEYS, TUNING_META } from '@/lib/client/particle/types'
import { useFxSettingsStore } from '@/lib/store/fx-settings-store'
import { FlaskConical, RotateCcw, X } from 'lucide-react'

export function ParticleTuningPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const fx = useFxSettingsStore((s) => s.fx)
  const tuningEnabled = useFxSettingsStore((s) => s.tuningEnabled)
  const toggleTuning = useFxSettingsStore((s) => s.toggleTuning)
  const update = useFxSettingsStore((s) => s.update)
  const reset = useFxSettingsStore((s) => s.resetTuningOnly)

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
      <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden="true" />
      {/* 左侧抽屉（与右侧的设置面板错开，便于同时开着对比） */}
      <aside
        className="fixed left-0 top-0 z-50 flex h-full w-[min(360px,88vw)] flex-col border-r border-border bg-card shadow-2xl"
        role="dialog"
        aria-label="实验调参"
      >
        {/* 顶栏 */}
        <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <FlaskConical className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-semibold">实验调参</span>
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">DEBUG</span>
          </div>
          <button
            onClick={onClose}
            className="touch-target flex items-center justify-center rounded-full p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
            aria-label="关闭实验调参"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 内容区 */}
        <div className="flex-1 overflow-y-auto px-4 py-4">
          <div className="mb-3 rounded-md bg-muted/50 px-2.5 py-2 text-[10px] leading-relaxed text-muted-foreground">
            这些原本是<b>硬编码在着色器里</b>的常数，现在可实时调节，无需重新构建。
            每项前开关默认打开，<b>关掉即按 0 下发</b>（原值保留，重开恢复）——
            从「全部归零」开始逐个打开，就能定位是哪个参数在影响观感。
            WebGPU / WebGL 两后端共用同一套值，可直接切换后端对比。
          </div>

          <div className="mb-4 flex gap-2">
            <button
              onClick={() => TUNING_KEYS.forEach((k) => toggleTuning(k, true))}
              className="flex-1 rounded-md border border-border px-2 py-1.5 text-[11px] text-muted-foreground transition hover:bg-accent hover:text-foreground"
            >
              全部开启
            </button>
            <button
              onClick={() => TUNING_KEYS.forEach((k) => toggleTuning(k, false))}
              className="flex-1 rounded-md border border-border px-2 py-1.5 text-[11px] text-muted-foreground transition hover:bg-accent hover:text-foreground"
            >
              全部归零（排查起点）
            </button>
          </div>

          <div className="space-y-4">
            {TUNING_KEYS.map((key) => {
              const meta = TUNING_META[key]
              const on = tuningEnabled[key] !== false
              return (
                <div key={key} className={on ? '' : 'opacity-60'}>
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <label className="flex cursor-pointer items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={(e) => toggleTuning(key, e.target.checked)}
                        className="h-3.5 w-3.5 accent-primary"
                        aria-label={`${meta.label} 开关`}
                      />
                      <span className="text-xs font-medium">{meta.label}</span>
                    </label>
                    <span className="tabular-nums text-[11px] text-muted-foreground">
                      {on ? Number(fx[key]).toFixed(2) : '0（已关闭）'}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={meta.min}
                    max={meta.max}
                    step={meta.step}
                    value={fx[key]}
                    disabled={!on}
                    onChange={(e) => update({ [key]: Number(e.target.value) })}
                    className="w-full accent-primary disabled:opacity-40"
                    aria-label={meta.label}
                  />
                  <p className="mt-0.5 text-[10px] leading-tight text-muted-foreground/70">
                    {meta.desc}
                  </p>
                </div>
              )
            })}
          </div>
        </div>

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
