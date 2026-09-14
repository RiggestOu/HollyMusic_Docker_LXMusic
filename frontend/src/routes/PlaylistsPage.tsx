import { useState, useRef, useEffect, type ChangeEvent } from 'react'
import {
  ListMusic,
  Plus,
  Sparkles,
  Download,
  Upload,
  CloudDownload,
  HardDrive,
  Music4,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { getPlaylist, addSongsToPlaylist, updatePlaylist, type PlaylistSummary } from '@/lib/api/playlists'
import { useAuthStore } from '@/hooks/useAuth'
import { usePlaylists } from '@/hooks/usePlaylists'
import { LoadingSkeleton } from '@/components/shared/LoadingSkeleton'
import { EmptyState } from '@/components/shared/EmptyState'
import { CreatePlaylistDialog } from '@@/components/playlists/CreatePlaylistDialog'
import { DeletePlaylistDialog } from '@@/components/playlists/DeletePlaylistDialog'
import { EditPlaylistDialog } from '@@/components/playlists/EditPlaylistDialog'
import { PlaylistGrid } from '@@/components/playlists/PlaylistGrid'
import { useDownloadQueue } from '@/hooks/useDownloadQueue'
import { toast } from '@/lib/toast'
import { usePlayerStore } from '@/lib/store/player-store'

// 歌单导入导出数据结构
interface ExportedPlaylistData {
  name: string
  comment: string | null
  isPublic: boolean
  songs: { songId: string; musicInfo: unknown }[]
}
interface PlaylistExportFile {
  app: string
  version: number
  exportedAt: string
  playlists: ExportedPlaylistData[]
}

export function PlaylistsPage() {
  const { playlists, loading, create, rename, remove, reload } = usePlaylists()
  const currentUsername = useAuthStore(s => s.username)

  // 下载队列（第 14 项：下载全部未下载歌曲）
  const queue = useDownloadQueue()

  // 直接播放本地音乐文件（绕过 UID 链路）
  const playLocalFile = (name: string) => {
    const url = `/api/local-music/play?name=${encodeURIComponent(name)}`
    usePlayerStore.setState({ streamUrl: url, isPlaying: true, currentTrack: null, bufferProgress: null })
  }

  // 本地音乐（第 12 项：浏览 NAS 落盘目录）
  interface LocalFile {
    name: string
    size: number
    mtime: number
  }
  const [localFiles, setLocalFiles] = useState<LocalFile[]>([])
  const [localLoading, setLocalLoading] = useState(false)
  const [localDir, setLocalDir] = useState('')

  useEffect(() => {
    let alive = true
    const load = async () => {
      setLocalLoading(true)
      try {
        const res = await fetch('/api/local-music')
        if (!res.ok) return
        const data = (await res.json()) as { dir?: string; files?: LocalFile[] }
        if (!alive) return
        setLocalDir(data.dir || '')
        setLocalFiles(data.files || [])
      } catch {
        // 读取失败保持空列表，不打扰用户
      } finally {
        if (alive) setLocalLoading(false)
      }
    }
    void load()
    return () => {
      alive = false
    }
  }, [queue.doneCount])

  /**
   * 下载全部未下载歌曲：
   * 遍历当前用户的全部歌单 → 汇总歌曲并按 uid 去重 → 已存在的跳过 → 其余串行下载。
   */
  const handleDownloadMissing = async () => {
    if (queue.running) return
    try {
      const all: Array<{ uid: string; name?: string; types?: unknown }> = []
      const seen = new Set<string>()
      for (const p of playlists) {
        try {
          // PlaylistDetail 的歌曲字段名在不同版本可能为 songs / tracks，
          // 这里做防御式读取，避免依赖具体字段名
          const detail = (await getPlaylist(p.id)) as unknown as Record<string, unknown>
          const raw = (detail?.songs ?? detail?.tracks ?? []) as Array<{
            uid?: string
            name?: string
            musicInfo?: { types?: unknown }
          }>
          const songs = Array.isArray(raw) ? raw : []
          for (const s of songs) {
            if (!s?.uid || seen.has(s.uid)) continue
            seen.add(s.uid)
            all.push({ uid: s.uid, name: s.name, types: s.musicInfo?.types })
          }
        } catch {
          // 单个歌单读取失败不阻断整体
        }
      }
      const n = await queue.enqueue(all, true)
      if (n === 0) {
        toast.info('本地已存在全部歌曲，无需下载')
        return
      }
      await queue.run()
      reloadLocal()
    } catch (e) {
      toast.info(e instanceof Error ? e.message : '下载失败')
    }
  }

  /** 下载单个歌单里的未下载歌曲（第 11 项，由歌单菜单触发）。 */
  const handleDownloadPlaylist = async (playlist: { id: number; name?: string }) => {
    if (queue.running) {
      toast.info('已有下载任务正在进行')
      return
    }
    try {
      const detail = (await getPlaylist(playlist.id)) as unknown as Record<string, unknown>
      const raw = (detail?.songs ?? detail?.tracks ?? []) as Array<{
        uid?: string
        name?: string
        musicInfo?: { types?: unknown }
      }>
      const songs = Array.isArray(raw) ? raw : []
      const items = songs
        .filter(t => !!t?.uid)
        .map(t => ({ uid: t.uid as string, name: t.name, types: t.musicInfo?.types }))
      const n = await queue.enqueue(items, true)
      if (n === 0) {
        toast.info('该歌单的歌曲本地已存在，无需下载')
        return
      }
      await queue.run()
      await reloadLocal()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '下载失败')
    }
  }

  const reloadLocal = async () => {
    try {
      const res = await fetch('/api/local-music')
      if (!res.ok) return
      const data = (await res.json()) as { dir?: string; files?: LocalFile[] }
      setLocalDir(data.dir || '')
      setLocalFiles(data.files || [])
    } catch {
      // 忽略
    }
  }
  const [showCreate, setShowCreate] = useState(false)
  const [editingPlaylist, setEditingPlaylist] = useState<PlaylistSummary | null>(null)
  const [deletingPlaylist, setDeletingPlaylist] = useState<PlaylistSummary | null>(null)
  const navigate = useNavigate()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleExport = async () => {
    try {
      const data: PlaylistExportFile = {
        app: 'HollyMusic',
        version: 1,
        exportedAt: new Date().toISOString(),
        playlists: [],
      }
      for (const pl of playlists) {
        const detail = await getPlaylist(pl.id)
        data.playlists.push({
          name: pl.name,
          comment: pl.comment,
          isPublic: pl.isPublic,
          songs: detail.entries.map(e => ({ songId: e.songId, musicInfo: e.musicInfo })),
        })
      }
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `hollymusic-playlists-${new Date().toISOString().slice(0, 10)}.json`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      alert(`已导出 ${data.playlists.length} 个歌单`)
    } catch (error) {
      alert(error instanceof Error ? error.message : '导出失败')
    }
  }

  const handleImportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      const text = await file.text()
      const data = JSON.parse(text) as PlaylistExportFile
      if (!data || !Array.isArray(data.playlists)) throw new Error('文件格式不正确')
      let created = 0
      let failed = 0
      for (const item of data.playlists) {
        try {
          const name = (item.name || '').trim() || '导入的歌单'
          const p = await create(name)
          const updates: { comment?: string; public?: boolean } = {}
          if (item.comment !== undefined) updates.comment = item.comment ?? undefined
          if (item.isPublic !== undefined) updates.public = item.isPublic
          if (Object.keys(updates).length > 0) await updatePlaylist(p.id, updates)
          const songIds = (item.songs || []).map(s => s.songId).filter(Boolean)
          if (songIds.length > 0) await addSongsToPlaylist(p.id, songIds)
          created++
        } catch {
          failed++
        }
      }
      await reload()
      alert(`导入完成：成功 ${created} 个，失败 ${failed} 个`)
    } catch (error) {
      alert(error instanceof Error ? error.message : '导入失败')
    }
  }

  const handleRename = async (name: string) => {
    if (!editingPlaylist) return
    try {
      await rename(editingPlaylist.id, name)
      setEditingPlaylist(null)
    } catch (error) {
      alert(error instanceof Error ? error.message : '保存失败')
    }
  }

  const handleDelete = async () => {
    if (!deletingPlaylist) return
    try {
      await remove(deletingPlaylist.id)
      setDeletingPlaylist(null)
    } catch (error) {
      alert(error instanceof Error ? error.message : '删除失败')
    }
  }

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="hidden text-2xl font-bold md:block">我的歌单</h1>
        <div className="flex flex-wrap items-center gap-2">
          {/* 第 14 项：下载全部未下载歌曲（默认最高质量，已存在的跳过） */}
          <button
            onClick={handleDownloadMissing}
            disabled={queue.running}
            className="flex items-center gap-1 rounded-full border border-border px-3 py-2 text-sm font-medium transition hover:bg-muted disabled:opacity-60"
            title="扫描全部歌单，把尚未保存到 NAS 的歌曲逐一落盘"
          >
            <CloudDownload className="h-4 w-4" />
            {queue.running
              ? `下载中 ${queue.doneCount}/${queue.tasks.length}`
              : '下载全部未下载歌曲'}
          </button>
          <button
            onClick={handleExport}
            className="flex items-center gap-1 rounded-full border border-border px-3 py-2 text-sm font-medium transition hover:bg-muted"
          >
            <Download className="h-4 w-4" /> 导出歌单
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-1 rounded-full border border-border px-3 py-2 text-sm font-medium transition hover:bg-muted"
          >
            <Upload className="h-4 w-4" /> 导入歌单
          </button>
          <button
            onClick={() => navigate('/playlists/ai-create')}
            className="flex items-center gap-1 rounded-full bg-primary/15 px-3 py-2 text-sm font-medium text-primary transition hover:bg-primary/25"
          >
            <Sparkles className="h-4 w-4" /> AI 建歌单
          </button>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-1 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <Plus className="h-4 w-4" /> 新建
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={handleImportFile}
        />
      </div>

      {loading ? (
        <LoadingSkeleton count={4} />
      ) : playlists.length > 0 ? (
        <PlaylistGrid
          playlists={playlists}
          currentUsername={currentUsername}
          onEdit={setEditingPlaylist}
          onDelete={setDeletingPlaylist}
          onDownload={handleDownloadPlaylist}
        />
      ) : (
        <EmptyState icon={ListMusic} title="还没有歌单" description="新建一个歌单开始整理" />
      )}

      {/* 第 12 项：本地音乐 —— 浏览 NAS 服务端落盘目录 */}
      <section className="mt-8">
        <div className="mb-3 flex items-center gap-2">
          <HardDrive className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">本地音乐</h2>
          <span className="text-xs text-muted-foreground">
            {localDir || '/app/prisma/prisma/data/music'}
          </span>
        </div>

        {localLoading ? (
          <p className="text-sm text-muted-foreground">加载中…</p>
        ) : localFiles.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            暂无本地音乐。可在歌曲或歌单上下载，文件会保存到上面的目录。
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {localFiles.map(f => (
              <li
                key={f.name}
                className="flex items-center gap-3 px-3 py-2 text-sm"
              >
                <Music4 className="h-4 w-4 shrink-0 text-primary" />
                <span className="min-w-0 flex-1 truncate" title={f.name}>
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
      </section>

      {showCreate && (
        <CreatePlaylistDialog
          onClose={() => setShowCreate(false)}
          onCreate={async name => {
            await create(name)
            setShowCreate(false)
          }}
        />
      )}

      {editingPlaylist && (
        <EditPlaylistDialog
          initialName={editingPlaylist.name}
          onClose={() => setEditingPlaylist(null)}
          onSave={handleRename}
        />
      )}

      {deletingPlaylist && (
        <DeletePlaylistDialog
          playlistName={deletingPlaylist.name}
          onClose={() => setDeletingPlaylist(null)}
          onConfirm={handleDelete}
        />
      )}
    </div>
  )
}

/** 字节数格式化。 */
function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '-'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 时间戳格式化为本地日期时间。 */
function formatDate(ms: number): string {
  if (!ms) return '-'
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
