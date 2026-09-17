/**
 * LensPresetsPanel —— 镜头预设管理面板
 *
 * 在设置面板的歌词显示选项下方，使用与歌词模式相同的卡片样式。
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
    loadPresets().then(data => {
      setPresets(data.presets)
      setIsLoaded(true)
    }).catch(console.error)
  }, [loadPresets])

  /** 另存预设 */
  const handleSave = async () => {
    const name = prompt('请输入预设名称:', `${visualPreset}_${lyricsMode}`)
    if (!name || !name.trim()) return

    try {
      const preset: LensPreset = {
        visual: visualPreset,
        lyrics_mode: lyricsMode,
        camera: cameraState,
        name: name.trim(),
        description: `镜头预设: ${name.trim()}`,
      }
      await savePreset(currentKey, preset)
      const updated = await loadPresets()
      setPresets(updated.presets)
      alert('✅ 预设已保存')
    } catch (err) {
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
    <div className="mt-3">
      {/* 标题行 */}
      <div className="mb-2 flex items-center gap-2">
        <Camera className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">镜头预设:</span>
        <span className="text-xs font-medium">{currentKey}</span>
      </div>

      {/* 操作按钮 - 使用与歌词模式相同的卡片样式 */}
      <div className="grid grid-cols-2 gap-2">
        <ActionButton
          icon={Save}
          label="另存"
          description="保存当前镜头"
          onClick={handleSave}
        />
        <ActionButton
          icon={Upload}
          label="导入"
          description="从文件导入"
          onClick={handleImport}
        />
        <ActionButton
          icon={Trash2}
          label="删除"
          description="删除当前预设"
          onClick={handleDelete}
          destructive
        />
        <ActionButton
          icon={RotateCcw}
          label="默认"
          description="恢复出厂设置"
          onClick={handleReset}
        />
      </div>
    </div>
  )
}

/** 统一的按钮样式组件 */
function ActionButton({
  icon: Icon,
  label,
  description,
  onClick,
  destructive = false,
}: {
  icon: React.ElementType
  label: string
  description: string
  onClick: () => void
  destructive?: boolean
}) {
  return (
    <button
      onClick={onClick}
      title={description}
      className={`flex flex-col items-center gap-1.5 rounded-lg border px-3 py-3 text-xs transition ${
        destructive
          ? 'border-destructive/30 text-destructive hover:bg-destructive/10'
          : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground'
      }`}
    >
      <Icon className="h-5 w-5" />
      <span className="font-medium">{label}</span>
      <span className="text-[10px] opacity-70">{description}</span>
    </button>
  )
}
