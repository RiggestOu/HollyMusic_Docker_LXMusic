/**
 * FxSettings Store —— 动效参数全局状态（zustand persist）。
 *
 * 与 preset / custom-image 等保持一致：读 localStorage 做持久化，
 * 跨窗口监听 storage 事件同步变化。
 */

import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import type { BackendPreference } from '@/lib/client/particle'
import { TUNING_KEYS, type TuningKey } from '@/lib/client/particle/types'

export interface FxSettings {
  intensity: number
  speed: number
  depth: number
  twist: number
  scatter: number
  bloom: number
  edge: number
  bgFade: number
  // 实验调参（默认值须与 lib/client/particle/types.ts 的 DEFAULT_FX 保持一致）
  spectrumAmp: number
  flowBase: number
  flowBass: number
  flowMid: number
  rippleAmp: number
  rippleBright: number
  pulseBase: number
  pulseBass: number
  burstAmp: number
  reliefAmp: number
  sizeBase: number
  sizeMax: number
  brightBase: number
  alphaBase: number
}

export const DEFAULT_FX: FxSettings = {
  intensity: 0.85,
  speed: 1.0,
  depth: 0.2,
  twist: 0,
  scatter: 0,
  bloom: 0.87,
  edge: 0.25,
  bgFade: 0.2,
  // 实验调参默认值（与 lib/client/particle/types.ts 的 DEFAULT_FX 保持一致）
  spectrumAmp: 0.06,
  flowBase: 0.55,
  flowBass: 1.6,
  flowMid: 0.65,
  rippleAmp: 0.13,
  rippleBright: 1.0,
  pulseBase: 0.03,
  pulseBass: 0.9,
  burstAmp: 1.6,
  reliefAmp: 1.0,
  sizeBase: 100.0,
  sizeMax: 4.95,
  brightBase: 0.7,
  alphaBase: 0.55,
}

/** 各调参项的钳位范围（防止极端值把着色器搞废）。 */
const TUNING_RANGE: Record<TuningKey, [number, number]> = {
  spectrumAmp: [0, 2],
  flowBase: [0, 5],
  flowBass: [0, 5],
  flowMid: [0, 5],
  rippleAmp: [0, 8],
  rippleBright: [0, 5],
  pulseBase: [0, 5],
  pulseBass: [0, 5],
  burstAmp: [0, 10],
  reliefAmp: [0, 3],
  sizeBase: [1, 200],
  sizeMax: [0.5, 20],
  brightBase: [0, 3],
  alphaBase: [0, 1],
}

export type TuningEnabled = Record<TuningKey, boolean>

/** 调参开关默认值：三个关键参数（涟漪亮度、节拍基数、节拍低频）默认关闭，其余打开。 */
function defaultTuningEnabled(): TuningEnabled {
  const out = {} as TuningEnabled
  for (const k of TUNING_KEYS) out[k] = true
  // 这三个参数会让"贴合粒子"歌词模式的平面与相机视角冲突，默认关闭
  out.rippleBright = false
  out.pulseBase = false
  out.pulseBass = false
  return out
}

/**
 * 把「开关关闭」的调参项按 0 下发，便于逐个隔离定位是哪个参数在影响观感。
 * 注意：只影响下发给渲染器的副本，不动用户设定的原值，重新打开即可恢复。
 */
export function resolveFx(fx: FxSettings, enabled: TuningEnabled): FxSettings {
  let dirty = false
  const out = { ...fx }
  for (const k of TUNING_KEYS) {
    if (!enabled[k] && out[k] !== 0) {
      out[k] = 0
      dirty = true
    }
  }
  return dirty ? out : fx
}

const STORAGE_KEY = 'hm-fx-settings'
const PREFERENCE_KEY = 'hm-backend-preference'

function loadStored(): FxSettings | null {
  if (typeof window === 'undefined') return null
  try {
    const v = window.localStorage.getItem(STORAGE_KEY)
    if (!v) return null
    const parsed = JSON.parse(v) as Partial<FxSettings> | null
    if (typeof parsed !== 'object' || parsed === null) return null
    // 只保留有合法数值的字段，缺失的字段全部走 DEFAULT_FX
    const merged: FxSettings = { ...DEFAULT_FX }
    for (const k of Object.keys(DEFAULT_FX) as Array<keyof FxSettings>) {
      const val = parsed[k]
      if (typeof val === 'number' && Number.isFinite(val)) {
        merged[k] = val
      }
    }
    return merged
  } catch {
    return null
  }
}

function loadStoredPreference(): BackendPreference {
  if (typeof window === 'undefined') return 'auto'
  try {
    const v = window.localStorage.getItem(PREFERENCE_KEY)
    if (v === 'webgpu' || v === 'webgl2') return v
  } catch {}
  return 'auto'
}

function savePreference(pref: BackendPreference): void {
  try {
    window.localStorage.setItem(PREFERENCE_KEY, pref)
  } catch {
    // 静默失败
  }
}

interface FxSettingsState {
  fx: FxSettings
  backendPreference: BackendPreference
  /** 实验调参的开关状态：关闭的项按 0 下发给渲染器（原值保留，重开即恢复）。 */
  tuningEnabled: TuningEnabled
  update: (partial: Partial<FxSettings>) => void
  toggleTuning: (key: TuningKey, on: boolean) => void
  /** 仅重置动效参数（bloom / intensity 等 8 项），不影响调参面板的 14 项。 */
  resetFx: () => void
  /** 仅重置调参面板的 14 项（bloom / spectrumAmp / flowBase 等），不动动效参数。 */
  resetTuningOnly: () => void
  /** 重置全部：动效参数 + 调参面板全部项。 */
  resetAll: () => void
  setBackendPreference: (pref: BackendPreference) => void
}

function persist(settings: FxSettings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    /* 静默失败（隐私模式等场景） */
  }
}

export const useFxSettingsStore = create<FxSettingsState>()(
  subscribeWithSelector((set) => ({
    fx: loadStored() ?? { ...DEFAULT_FX },
    backendPreference: loadStoredPreference(),
    tuningEnabled: defaultTuningEnabled(),
    update: (partial) =>
      set((s) => {
        const next = { ...s.fx, ...partial }
        // 钳位到合理范围（防止极端值把着色器搞废）
        next.intensity = Math.max(0.1, Math.min(2.0, next.intensity))
        next.speed = Math.max(0.05, Math.min(5.0, next.speed))
        next.depth = Math.max(0, Math.min(2.0, next.depth))
        next.twist = Math.max(0, Math.min(1.0, next.twist))
        next.scatter = Math.max(0, Math.min(1.0, next.scatter))
        next.bloom = Math.max(0, Math.min(3.0, next.bloom))
        next.edge = Math.max(0, Math.min(3.0, next.edge))
        next.bgFade = Math.max(0, Math.min(2.0, next.bgFade))
        // 实验调参项：按各自区间钳位
        for (const k of TUNING_KEYS) {
          const [lo, hi] = TUNING_RANGE[k]
          next[k] = Math.max(lo, Math.min(hi, next[k]))
        }
        persist(next)
        // 广播，让同时打开的 Tauri 歌词窗口同步
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new Event('hm-fx-changed'))
        }
        return { fx: next }
      }),
    toggleTuning: (key, on) => {
      set((s) => ({ tuningEnabled: { ...s.tuningEnabled, [key]: on } }))
      // 让 Tauri 歌词窗口等同屏实例同步
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('hm-fx-changed'))
      }
    },
    reset: () => {
      persist(DEFAULT_FX)
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('hm-fx-changed'))
      }
      set({ fx: { ...DEFAULT_FX }, tuningEnabled: defaultTuningEnabled() })
    },
    /** 仅重置动效参数（bloom / intensity 等 8 项），不影响调参面板。 */
    resetFx: () => {
      const resetFxBx = { ...DEFAULT_FX }
      // 只保留动效参数，保留调参项的当前值
      for (const k of TUNING_KEYS) {
        delete (resetFxBx as Record<string, unknown>)[k]
      }
      set((s) => {
        const next = { ...s.fx, ...resetFxBx }
        persist(next)
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new Event('hm-fx-changed'))
        }
        return { fx: next }
      })
    },
    /** 仅重置调参面板的 14 项（spectrumAmp/flowBase/rippleBright 等），不动动效参数。 */
    resetTuningOnly: () => {
      const tuningDefaults: Partial<FxSettings> = {}
      for (const k of TUNING_KEYS) {
        tuningDefaults[k] = DEFAULT_FX[k] as FxSettings[keyof FxSettings]
      }
      persist({ ...DEFAULT_FX })
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('hm-fx-changed'))
      }
      set((s) => ({
        fx: { ...s.fx, ...tuningDefaults },
        tuningEnabled: defaultTuningEnabled(),
      }))
    },
    /** 重置全部：动效参数 + 调参面板全部项。 */
    resetAll: () => {
      persist(DEFAULT_FX)
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('hm-fx-changed'))
      }
      set({ fx: { ...DEFAULT_FX }, tuningEnabled: defaultTuningEnabled() })
    },
    setBackendPreference: (pref: BackendPreference) => {
      savePreference(pref)
      set({ backendPreference: pref })
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('hm-backend-preference-changed'))
      }
    },
  })),
)
