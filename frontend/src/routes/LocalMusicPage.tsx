import { useEffect, useState } from 'react'
import { HardDrive, Music4, RefreshCw, Play } from 'lucide-react'
import { usePlayerStore } from '@/lib/store/player-store'
import { toast } from '@/lib/toast'

interface LocalFile {
  name: string
  size: number
  mtime: number
}

export function LocalMusicPage() {
  const [files, setFiles] = useState<LocalFile[]>([])
  const [loading, setLoading] = useState(false)
  const [dir, setDir] = useState('')
  const playTrack = usePlayerStore(s => s.playTrack)

  const loadFiles = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/local-music')
      if (!res.ok) return
      const data = (await res.json()) as { dir?: string; files?: LocalFile[] }
      setDir(data.dir || '')
      setFiles(data.files || [])
    } catch {
      toast.error('加载本地音乐失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadFiles()
  }, [])

  const playLocalFile = (name: string) => {
    const url = `/api/local-music/play?name=${encodeURIComponent(name)}`
    usePlayerStore.setState({
      streamUrl: url,
      isPlaying: true,
      currentTrack: null,
      bufferProgress: null,
    })
  }

  const formatBytes = (bytes: number): string => {
    if (!bytes) return '-'
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  }

  const formatDate = (ms: number): string => {
    if (!ms) return '-'
    const d = new Date(ms)
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  }

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <HardDrive className="h-6 w-6 text-primary" />
            本地音乐
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {dir || '/app/prisma/prisma/data/music'}
          </p>
        </div>
        <button
          onClick={loadFiles}
          disabled={loading}
          className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm transition hover:bg-accent disabled:opacity-60"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          刷新
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <p className="text-sm text-muted-foreground">加载中…</p>
        </div>
      ) : files.length === 0 ? (
        <div className="rounded-lg border border-border p-8 text-center">
          <HardDrive className="mx-auto h-12 w-12 text-muted-foreground/50" />
          <h3 className="mt-4 text-lg font-medium">暂无本地音乐</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            在歌曲或歌单上点击下载，文件会保存到 NAS 目录。
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {files.map(f => (
            <li
              key={f.name}
              className="flex items-center gap-3 px-4 py-3 hover:bg-accent/50"
            >
              <button
                onClick={() => playLocalFile(f.name)}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground transition hover:opacity-90"
                title="播放"
              >
                <Play className="h-4 w-4 fill-current" />
              </button>
              <Music4 className="h-4 w-4 shrink-0 text-primary" />
              <span className="min-w-0 flex-1 truncate text-sm" title={f.name}>
                {f.name}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {formatBytes(f.size)}
              </span>
              <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                {formatDate(f.mtime)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
