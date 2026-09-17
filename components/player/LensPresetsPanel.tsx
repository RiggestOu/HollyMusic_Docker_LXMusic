/**
 * LensPresetsPanel —— 镜头预设管理面板
 * 
 * 在歌词显示面板底部提供四个按钮：
 * 1. 另存预设 - 保存当前镜头到指定预设
 * 2. 导入预设 - 从文件导入预设
 * 3. 删除预设 - 删除当前预设
 * 4. 恢复默认 - 重置所有预设到默认值
 */

import { useState, useEffect } from 'react'
import { useLensPresets, makePresetKey, type LensPreset, type LyricsMode } from '@/hooks/use-lens-presets'
import { Camera, Save, Upload, Trash2, RotateCcw } from 'lucide-react'

interface LensPresetsPanelProps {
  visualPreset: string
  lyricsMode: LyricsMode
  cameraState: { theta: number; phi: number; radius: number; target: [number, number, number] }
}

export function LensPresetsPanel({
  visualPreset,
  lyricsMode,
  cameraState,
}: LensPresetsPanelProps) {
  const { loadPresets, savePreset, deletePreset, resetPresets, importPresets, exportPresets } = useLensPresets()
  const [presets, setPresets] = useState<Record<string, LensPreset>>({})
  const [isLoaded, setIsLoaded] = useState(false)

  // 当前预设 key
  const currentKey = makePresetKey(visualPreset, lyricsMode)

  // 加载预设列表
  useEffect(() => {
    console.info('[LensPresets] 开始加载预设')
    loadPresets().then(data => {
      console.info('[LensPresets] 加载成功，预设数量:', Object.keys(data.presets).length)
      setPresets(data.presets)
      setIsLoaded(true)
    }).catch(err => {
      console.error('[LensPresets] 加载失败:', err)
    })
  }, [loadPresets])

  /** 另存预设 */
  const handleSave = async () => {
    try {
      // 弹出输入框让用户输入名称
      const name = prompt('请输入预设名称:', `${visualPreset}_${lyricsMode}`)
      if (!name || !name.trim()) {
        console.info('[LensPresets] 用户取消或输入空名称')
        return
      }

      const preset: LensPreset = {
        visual: visualPreset,
        lyrics_mode: lyricsMode,
        camera: cameraState,
        name: name.trim(),
        description: `镜头预设: ${name.trim()}`,
      }
      console.info('[LensPresets] 保存预设:', currentKey, '名称:', name.trim())
      await savePreset(currentKey, preset)
      // 刷新列表
      const updated = await loadPresets()
      setPresets(updated.presets)
      alert('✅ 预设已保存')
    } catch (err) {
      console.error('[LensPresets] 保存失败:', err)
      alert('❌ 保存失败: ' + err)
    }
  }

  /** 导入预设 */
  const handleImport = async () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json'
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (!file) return
      try {
        const text = await file.text()
        const data = JSON.parse(text)
        await importPresets(data)
        const updated = await loadPresets()
        setPresets(updated.presets)
        alert('✅ 导入成功')
      } catch (err) {
        alert('❌ 导入失败: ' + err)
      }
    }
    input.click()
  }

  /** 删除预设 */
  const handleDelete = async () => {
    if (!confirm(`确定要删除预设 "${currentKey}" 吗？`)) return
    try {
      await deletePreset(currentKey)
      const updated = await loadPresets()
      setPresets(updated.presets)
      alert('✅ 预设已删除')
    } catch (err) {
      alert('❌ 删除失败: ' + err)
    }
  }

  /** 恢复默认 */
  const handleReset = async () => {
    if (!confirm('确定要恢复所有镜头预设为默认值吗？这将清除所有自定义设置。')) return
    try {
      await resetPresets()
      const updated = await loadPresets()
      setPresets(updated.presets)
      alert('✅ 已恢复默认')
    } catch (err) {
      alert('❌ 恢复失败: ' + err)
    }
  }

  if (!isLoaded) return null

  return (
    <div className="flex flex-col gap-1 px-4 py-2 border-t border-border bg-card/50">
      {/* 第一行：镜头预设名称 */}
      <div className="flex items-center gap-2">
        <Camera className="h-4 w-4 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">镜头预设:</span>
        <span className="text-xs font-medium">{currentKey}</span>
      </div>
      
      {/* 第二行：保存和导入按钮 */}
      <div className="flex gap-1">
        <button
          onClick={handleSave}
          className="flex items-center gap-1 rounded px-2 py-1 text-[11px] transition hover:bg-accent"
          title="另存当前镜头为预设"
        >
          <Save className="h-3 w-3" />
          <span>另存</span>
        </button>
        
        <button
          onClick={handleImport}
          className="flex items-center gap-1 rounded px-2 py-1 text-[11px] transition hover:bg-accent"
          title="从文件导入预设"
        >
          <Upload className="h-3 w-3" />
          <span>导入</span>
        </button>
      </div>
      
      {/* 第三行：删除和恢复默认按钮 */}
      <div className="flex gap-1">
        <button
          onClick={handleDelete}
          className="flex items-center gap-1 rounded px-2 py-1 text-[11px] transition hover:bg-accent text-destructive"
          title="删除当前预设"
        >
          <Trash2 className="h-3 w-3" />
          <span>删除</span>
        </button>
        
        <button
          onClick={handleReset}
          className="flex items-center gap-1 rounded px-2 py-1 text-[11px] transition hover:bg-accent"
          title="恢复所有预设为默认"
        >
          <RotateCcw className="h-3 w-3" />
          <span>默认</span>
        </button>
      </div>
    </div>
  )
}
