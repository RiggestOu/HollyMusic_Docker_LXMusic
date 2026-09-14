/**
 * FxSettings Store —— 动效参数全局状态（zustand persist）。
 *
 * 与 preset / custom-image 等保持一致：读 localStorage 做持久化，
 * 跨窗口监听 storage 事件同步变化。
 */

import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import type { BackendPreference } from '@/lib/client/particle'

export interface FxSettings {
  intensity: number
  speed: number
  depth: number
  twist: number
  scatter: number
  bloom: number
  edge: number
  bgFade: number
}

export const DEFAULT_FX: FxSettings = {
  intensity: 0.85,
  speed: 1.0,
  depth: 0.2,
  twist: 0,
  scatter: 0,
  bloom: 0.62,
  edge: 1,
  bgFade: 0.2,
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
  update: (partial: Partial<FxSettings>) => void
  reset: () => void
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
        persist(next)
        // 广播，让同时打开的 Tauri 歌词窗口同步
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new Event('hm-fx-changed'))
        }
        return { fx: next }
      }),
    reset: () => {
      persist(DEFAULT_FX)
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('hm-fx-changed'))
      }
      set({ fx: { ...DEFAULT_FX } })
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
