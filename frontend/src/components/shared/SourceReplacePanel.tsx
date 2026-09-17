import { useState, useEffect } from 'react'
import { X, Music, AlertCircle } from 'lucide-react'
import { toast } from '@/lib/toast'
import type { MusicInfo } from '@/lib/types/music'

interface SourceResult {
  source: string
  songmid: string
  name: string
  artist: string
  album: string
  duration: number
  types: string[]
  img: string
}

interface SourceReplacePanelProps {
  track: {
    uid: string
    name: string
    artist: string
    musicInfo: MusicInfo
  }
  onClose: () => void
  onSwitch: (newMusicInfo: MusicInfo) => void
}

const SOURCE_NAMES: Record<string, string> = {
  kw: 'QQ音乐',
  kg: '酷狗音乐',
  tx: '网易云',
  wy: '腾讯',
  mg: '咪咕',
}

export function SourceReplacePanel({ track, onClose, onSwitch }: SourceReplacePanelProps) {
  const [results, setResults] = useState<SourceResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchSwitchSources()
  }, [])

  const fetchSwitchSources = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/music/switch-source', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uid: track.uid,
          musicInfo: track.musicInfo,
        }),
      })
      const data = await res.json() as { results?: SourceResult[]; error?: string }
      if (!res.ok) throw new Error(data.error || '查询失败')
      setResults(data.results || [])
    } catch (err) {
      const msg = err instanceof Error ? err.message : '查询失败'
      setError(msg)
      toast.error(`更换音源失败: ${msg}`)
    } finally {
      setLoading(false)
    }
  }

  const handleSwitch = async (result: SourceResult) => {
    try {
      const qualityTypes = result.types as Array<'128k' | '320k' | 'flac' | 'flac24bit'>
      // 构建 types 数组
      const types = qualityTypes.map(t => ({ type: t, size: '' }))

      // _types 必须包含所有 QualityType 键（使用 Partial 允许缺失）
      const _types: Record<'128k' | '320k' | 'flac' | 'flac24bit', { type: string; size: string } | undefined> = {
        '128k': undefined,
        '320k': undefined,
        flac: undefined,
        flac24bit: undefined,
      }
      for (const t of qualityTypes) {
        _types[t] = { type: t, size: '' }
      }

      const newMusicInfo: MusicInfo = {
        source: result.source as 'kw' | 'kg' | 'tx' | 'wy' | 'mg',
        songmid: result.songmid,
        name: result.name,
        singer: result.artist,
        albumId: '',
        albumName: result.album,
        interval: String(result.duration),
        types,
        _types: _types as any, // 类型转换，因为 TypeScript 无法推断 Partial 行为
        typeUrl: {},
        img: result.img || null,
      }
      onSwitch(newMusicInfo)
      toast.success('已更换音源')
      onClose()
    } catch (err) {
      const msg = err instanceof Error ? err.message : '更换失败'
      toast.error(msg)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="relative w-full max-w-md max-h-[80vh] overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* 顶栏 */}
        <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">更换音源</h2>
            <p className="mt-0.5 text-xs text-muted-foreground truncate">
              {track.name} - {track.artist}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-full p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 内容区 */}
        <div className="overflow-y-auto px-4 py-4">
          {loading && (
            <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-current border-t-transparent" />
              <span className="text-xs">搜索中...</span>
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {!loading && !error && results.length === 0 && (
            <div className="py-8 text-center text-sm text-muted-foreground">
              未找到其他音源版本
            </div>
          )}

          {!loading && !error && results.length > 0 && (
            <div className="space-y-2">
              <p className="mb-2 text-xs text-muted-foreground">
                找到 {results.length} 个可用音源
              </p>
              {results.map((result, i) => (
                <button
                  key={i}
                  onClick={() => handleSwitch(result)}
                  className="flex w-full items-center gap-3 rounded-lg border border-border p-3 text-left transition hover:bg-accent"
                >
                  <Music className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{result.name}</span>
                      <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">
                        {SOURCE_NAMES[result.source] || result.source}
                      </span>
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {result.artist} · {result.album}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 底栏 */}
        <div className="shrink-0 border-t border-border px-4 py-3">
          <button
            onClick={fetchSwitchSources}
            disabled={loading}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            重新搜索
          </button>
        </div>
      </div>
    </div>
  )
}
