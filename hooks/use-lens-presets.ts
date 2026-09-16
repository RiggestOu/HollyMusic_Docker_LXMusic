/**
 * Lens Presets Client Hook
 * 
 * 提供镜头预设的持久化管理功能，39个预设 = 13视觉预设 × 3歌词模式
 */

import { useCallback } from 'react'

const API_BASE = '/api/lens-presets'

export type LyricsMode = 'tile' | 'plane' | 'single'

export interface LensPreset {
  visual: string
  lyrics_mode: LyricsMode
  camera: {
    theta: number
    phi: number
    radius: number
    target: [number, number, number]
  }
  name: string
  description: string
}

export function useLensPresets() {
  /** 加载所有预设 */
  const loadPresets = useCallback(async () => {
    const res = await fetch(API_BASE)
    if (!res.ok) throw new Error('Failed to load lens presets')
    return res.json() as Promise<{ presets: Record<string, LensPreset> }>
  }, [])

  /** 保存单个预设 */
  const savePreset = useCallback(async (key: string, preset: LensPreset) => {
    const res = await fetch(API_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'save', key, preset }),
    })
    if (!res.ok) throw new Error('Failed to save lens preset')
    return res.json()
  }, [])

  /** 删除单个预设 */
  const deletePreset = useCallback(async (key: string) => {
    const res = await fetch(API_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', key }),
    })
    if (!res.ok) throw new Error('Failed to delete lens preset')
    return res.json()
  }, [])

  /** 恢复默认预设 */
  const resetPresets = useCallback(async () => {
    const res = await fetch(API_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reset' }),
    })
    if (!res.ok) throw new Error('Failed to reset lens presets')
    return res.json()
  }, [])

  /** 导出预设到文件 */
  const exportPresets = useCallback(async (filePath: string) => {
    const res = await fetch(API_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'export', filePath }),
    })
    if (!res.ok) throw new Error('Failed to export lens presets')
    return res.json()
  }, [])

  /** 从文件导入预设 */
  const importPresets = useCallback(async (filePath: string) => {
    const res = await fetch(API_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'import', filePath }),
    })
    if (!res.ok) throw new Error('Failed to import lens presets')
    return res.json()
  }, [])

  return {
    loadPresets,
    savePreset,
    deletePreset,
    resetPresets,
    exportPresets,
    importPresets,
  }
}

/** 生成预设 key */
export function makePresetKey(visual: string, lyricsMode: 'tile' | 'plane' | 'single'): string {
  return `${visual}_${lyricsMode}`
}
