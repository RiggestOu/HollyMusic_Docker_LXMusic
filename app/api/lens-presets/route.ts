/**
 * Lens Presets API Routes
 * 
 * POST /api/lens-presets/save - 保存单个预设
 * POST /api/lens-presets/delete - 删除预设
 * POST /api/lens-presets/reset - 恢复默认
 * POST /api/lens-presets/export - 导出到文件
 * POST /api/lens-presets/import - 从文件导入
 */

import { NextRequest, NextResponse } from 'next/server'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'

const LENS_DIR = join(process.cwd(), 'prisma_data', 'LensPresets')
const CURRENT_FILE = join(LENS_DIR, 'current_preset.json')

export async function POST(request: NextRequest) {
  const { action, key } = await request.json()
  
  if (!action) {
    return NextResponse.json({ error: 'Missing action' }, { status: 400 })
  }
  
  try {
    switch (action) {
      case 'save': {
        const { preset } = await request.json()
        await ensureLensDir()
        const current = await loadCurrentFile()
        current.presets[key] = preset
        current.modified_at = new Date().toISOString()
        await writeFile(CURRENT_FILE, JSON.stringify(current, null, 2), 'utf-8')
        return NextResponse.json({ success: true })
      }
      
      case 'delete': {
        await ensureLensDir()
        const current = await loadCurrentFile()
        delete current.presets[key]
        current.modified_at = new Date().toISOString()
        await writeFile(CURRENT_FILE, JSON.stringify(current, null, 2), 'utf-8')
        return NextResponse.json({ success: true })
      }
      
      case 'reset': {
        await ensureLensDir()
        // 从 default_preset.json 加载默认预设
        const defaultFile = join(LENS_DIR, 'default_preset.json')
        let defaults = { version: '1.0', presets: {} }
        try {
          const raw = await readFile(defaultFile, 'utf-8')
          defaults = JSON.parse(raw)
        } catch {
          // 如果 default_preset.json 不存在，使用空对象
          logger.warn('[lens-presets] default_preset.json not found, using empty defaults')
        }
        await writeFile(CURRENT_FILE, JSON.stringify(defaults, null, 2), 'utf-8')
        logger.info('[lens-presets] reset to defaults')
        return NextResponse.json({ success: true })
      }
      
      case 'export': {
        const { filePath } = await request.json()
        await ensureLensDir()
        const current = await loadCurrentFile()
        await writeFile(filePath, JSON.stringify(current, null, 2), 'utf-8')
        return NextResponse.json({ success: true })
      }
      
      case 'import': {
        const { filePath } = await request.json()
        const raw = await readFile(filePath, 'utf-8')
        const data = JSON.parse(raw)
        if (!data.presets || typeof data.presets !== 'object') {
          return NextResponse.json({ error: 'Invalid preset file' }, { status: 400 })
        }
        await ensureLensDir()
        await writeFile(CURRENT_FILE, JSON.stringify(data, null, 2), 'utf-8')
        return NextResponse.json({ success: true })
      }
      
      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    }
  } catch (error) {
    console.error('Lens presets error:', error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}

export async function GET() {
  try {
    await ensureLensDir()
    const current = await loadCurrentFile()

    // 如果 current 为空，从 default_preset.json 加载默认值
    if (!current.presets || Object.keys(current.presets).length === 0) {
      const defaultFile = join(LENS_DIR, 'default_preset.json')
      try {
        const raw = await readFile(defaultFile, 'utf-8')
        const defaults = JSON.parse(raw)
        await writeFile(CURRENT_FILE, JSON.stringify(defaults, null, 2), 'utf-8')
        logger.info('[lens-presets] initialized from default_preset.json')
        return NextResponse.json(defaults)
      } catch {
        logger.warn('[lens-presets] default_preset.json not found, using empty presets')
        return NextResponse.json(current)
      }
    }

    return NextResponse.json(current)
  } catch (error) {
    logger.error('[lens-presets] GET error:', error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}

async function ensureLensDir(): Promise<void> {
  if (!existsSync(LENS_DIR)) {
    mkdirSync(LENS_DIR, { recursive: true })
  }
}

async function loadCurrentFile() {
  try {
    const raw = await readFile(CURRENT_FILE, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return { version: '1.0', presets: {} }
  }
}
