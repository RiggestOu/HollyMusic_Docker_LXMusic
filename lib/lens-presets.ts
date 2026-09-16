/**
 * LensPresets —— 镜头预设持久化模块
 * 
 * 39 种预设 = 13 视觉预设 × 3 歌词模式（tile / plane / single）
 * 
 * 存储位置：
 *   prisma_data/LensPresets/default_preset.json  ← 硬编码默认值
 *   prisma_data/LensPresets/current_preset.json  ← 用户自定义覆盖
 */

import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'

export const LENS_DIR = join(process.cwd(), 'prisma_data', 'LensPresets')
export const DEFAULT_FILE = join(LENS_DIR, 'default_preset.json')
export const CURRENT_FILE = join(LENS_DIR, 'current_preset.json')

export type LyricsMode = 'tile' | 'plane' | 'single'
export const LYRICS_MODES: LyricsMode[] = ['tile', 'plane', 'single']

export interface CameraState {
  theta: number
  phi: number
  radius: number
  target: [number, number, number]
}

export interface LensPreset {
  visual: string
  lyrics_mode: LyricsMode
  camera: CameraState
  name: string
  description: string
}

export interface LensPresetFile {
  version: string
  created_at?: string
  modified_at?: string | null
  presets: Record<string, LensPreset>
}

export async function ensureLensDir(): Promise<void> {
  if (!existsSync(LENS_DIR)) {
    mkdirSync(LENS_DIR, { recursive: true })
  }
}

export async function loadDefaultFile(): Promise<LensPresetFile> {
  try {
    const raw = await readFile(DEFAULT_FILE, 'utf-8')
    return JSON.parse(raw) as LensPresetFile
  } catch {
    return { version: '1.0', presets: {} }
  }
}

export async function loadCurrentFile(): Promise<LensPresetFile> {
  try {
    const raw = await readFile(CURRENT_FILE, 'utf-8')
    return JSON.parse(raw) as LensPresetFile
  } catch {
    return { version: '1.0', presets: {} }
  }
}

export function makePresetKey(visual: string, lyricsMode: LyricsMode): string {
  return `${visual}_${lyricsMode}`
}

export async function loadLensPresets(): Promise<Record<string, LensPreset>> {
  await ensureLensDir()
  const [defaultData, currentData] = await Promise.all([
    loadDefaultFile(),
    loadCurrentFile(),
  ])
  return { ...defaultData.presets, ...currentData.presets }
}

export async function saveLensPreset(key: string, preset: LensPreset): Promise<void> {
  await ensureLensDir()
  const current = await loadCurrentFile()
  current.presets[key] = preset
  current.modified_at = new Date().toISOString()
  await writeFile(CURRENT_FILE, JSON.stringify(current, null, 2), 'utf-8')
}

export async function deleteLensPreset(key: string): Promise<void> {
  await ensureLensDir()
  const current = await loadCurrentFile()
  delete current.presets[key]
  current.modified_at = new Date().toISOString()
  await writeFile(CURRENT_FILE, JSON.stringify(current, null, 2), 'utf-8')
}

export async function resetLensPresets(): Promise<void> {
  await ensureLensDir()
  const empty: LensPresetFile = { version: '1.0', presets: {} }
  await writeFile(CURRENT_FILE, JSON.stringify(empty, null, 2), 'utf-8')
}

export async function getLensCamera(visual: string, lyricsMode: LyricsMode): Promise<CameraState | null> {
  const presets = await loadLensPresets()
  const preset = presets[makePresetKey(visual, lyricsMode)]
  return preset ? preset.camera : null
}

export async function batchSaveLensPresets(updates: Record<string, LensPreset>): Promise<void> {
  await ensureLensDir()
  const current = await loadCurrentFile()
  current.presets = { ...current.presets, ...updates }
  current.modified_at = new Date().toISOString()
  await writeFile(CURRENT_FILE, JSON.stringify(current, null, 2), 'utf-8')
}

export async function importLensPresets(filePath: string): Promise<void> {
  const raw = await readFile(filePath, 'utf-8')
  const data = JSON.parse(raw) as LensPresetFile
  if (!data.presets || typeof data.presets !== 'object') {
    throw new Error('Invalid preset file: missing presets object')
  }
  await ensureLensDir()
  await writeFile(CURRENT_FILE, JSON.stringify(data, null, 2), 'utf-8')
}

export async function exportLensPresets(filePath: string): Promise<void> {
  const current = await loadCurrentFile()
  await ensureLensDir()
  await writeFile(filePath, JSON.stringify(current, null, 2), 'utf-8')
}
