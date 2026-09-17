import { useState, useRef, useEffect, useCallback, type ChangeEvent } from 'react'
import {
  ListMusic,
  Plus,
  Sparkles,
  Download,
  Upload,
  CloudDownload,
  HardDrive,
  Music4,
  Trash2,
  CheckCheck,
  Merge,
  Loader2,
  XCircle,
  CheckCircle2,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { getPlaylist, addSongsToPlaylist, updatePlaylist, deletePlaylist, type PlaylistSummary, type ImportPlaylistSong } from '@/lib/api/playlists'
import { useAuthStore } from '@/hooks/useAuth'
import { usePlaylists } from '@/hooks/usePlaylists'
import { LoadingSkeleton } from '@/components/shared/LoadingSkeleton'
import { EmptyState } from '@/components/shared/EmptyState'
import { CreatePlaylistDialog } from '@@/components/playlists/CreatePlaylistDialog'
import { DeletePlaylistDialog } from '@@/components/playlists/DeletePlaylistDialog'
import { EditPlaylistDialog } from '@@/components/playlists/EditPlaylistDialog'
import { MergePlaylistDialog } from '@@/components/playlists/MergePlaylistDialog'
import { PlaylistGrid } from '@@/components/playlists/PlaylistGrid'
import { useDownloadQueue } from '@/hooks/useDownloadQueue'
import { toast } from '@/lib/toast'
import { usePlayerStore } from '@/lib/store/player-store'

// 歌单导入导出数据结构
interface ExportedPlaylistData {
  name: string
  comment: string | null
  isPublic: boolean
  coverArt?: string | null
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

  // 歌单排序方式
  type PlaylistSort = 'name' | 'songCount' | 'createdAt'
  const [sortField, setSortField] = useState<PlaylistSort>('createdAt')
  const [sortAsc, setSortAsc] = useState(false)

  // 排序后的歌单列表
  const sortedPlaylists = [...playlists].sort((a, b) => {
    let cmp = 0
    if (sortField === 'name') {
      cmp = a.name.localeCompare(b.name, 'zh-CN')
    } else if (sortField === 'songCount') {
      cmp = (a.songCount || 0) - (b.songCount || 0)
    } else {
      cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    }
    return sortAsc ? cmp : -cmp
  })

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
          const detail = await getPlaylist(p.id)
          // API 返回格式: { entries: [{ songId, musicInfo, ... }] }
          const songs = Array.isArray(detail?.entries) ? detail.entries : []
          for (const s of songs) {
            if (!s?.songId || seen.has(s.songId)) continue
            seen.add(s.songId)
            const mi = s.musicInfo as { source?: string; songmid?: string; name?: string; types?: unknown } | null
            const uid = mi?.source && mi?.songmid ? `${mi.source}-${mi.songmid}` : undefined
            if (!uid) continue
            all.push({ uid, name: mi?.name, types: mi?.types })
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
      await reloadLocal()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '下载失败')
    }
  }

  /** 下载单个歌单里的未下载歌曲（第 11 项，由歌单菜单触发）。 */
  const handleDownloadPlaylist = async (playlist: { id: number; name?: string }) => {
    if (queue.running) {
      toast.info('已有下载任务正在进行')
      return
    }
    try {
      const detail = await getPlaylist(playlist.id)
      const songs = Array.isArray(detail?.entries) ? detail.entries : []
      const items = songs
        .filter(t => !!t?.songId && t.musicInfo?.source && t.musicInfo?.songmid)
        .map(t => {
          const mi = t.musicInfo as { source: string; songmid: string; name?: string; types?: unknown }
          return { uid: `${mi.source}-${mi.songmid}`, name: mi.name, types: mi.types }
        })
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

  /** 下载选中歌单的未下载歌曲 */
  const handleDownloadSelected = async () => {
    if (queue.running || selectedIds.size === 0) return
    try {
      const all: Array<{ uid: string; name?: string; types?: unknown }> = []
      const seen = new Set<string>()
      for (const p of playlists.filter(pl => selectedIds.has(pl.id))) {
        try {
          const detail = await getPlaylist(p.id)
          const songs = Array.isArray(detail?.entries) ? detail.entries : []
          for (const s of songs) {
            if (!s?.songId || seen.has(s.songId)) continue
            seen.add(s.songId)
            const mi = s.musicInfo as { source?: string; songmid?: string; name?: string; types?: unknown } | null
            const uid = mi?.source && mi?.songmid ? `${mi.source}-${mi.songmid}` : undefined
            if (!uid) continue
            all.push({ uid, name: mi?.name, types: mi?.types })
          }
        } catch {
          // 单个歌单读取失败不阻断整体
        }
      }
      const n = await queue.enqueue(all, true)
      if (n === 0) {
        toast.info('选中歌单本地已存在全部歌曲，无需下载')
        return
      }
      await queue.run()
      await reloadLocal()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '下载失败')
    } finally {
      setSelectMode(false)
      setSelectedIds(new Set())
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

  // 批量选中状态
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [batchDeleting, setBatchDeleting] = useState(false)
  const [showMerge, setShowMerge] = useState(false)
  const [merging, setMerging] = useState(false)
  // 选择模式开关
  const [selectMode, setSelectMode] = useState(false)

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
        // 使用第一首歌的封面作为歌单封面
        const coverArt = detail.entries?.[0]?.musicInfo?.img || pl.coverArt || null
        data.playlists.push({
          name: pl.name,
          comment: pl.comment,
          isPublic: pl.isPublic,
          coverArt,
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
    console.info(`[导入] 开始处理文件「${file.name}」，大小=${file.size} 字节`)
    try {
      const text = await file.text()
      const data = JSON.parse(text) as PlaylistExportFile
      if (!data || !Array.isArray(data.playlists)) throw new Error('文件格式不正确')
      console.info(`[导入] 解析成功：version=${data.version ?? 1}，歌单数=${data.playlists.length}`)

      // Version 2 format: pass musicInfo to backend
      if (data.version === 2) {
        // 前端去重：每个歌单内的 songId 去重
        let totalDeduplicated = 0
        const deduplicatedPlaylists = data.playlists.map(playlist => {
          const seen = new Set<string>()
          const uniqueSongs: ImportPlaylistSong[] = []
          for (const song of playlist.songs || []) {
            if (song.songId && !seen.has(song.songId)) {
              seen.add(song.songId)
              uniqueSongs.push(song)
            }
          }
          const removed = (playlist.songs?.length || 0) - uniqueSongs.length
          if (removed > 0) {
            console.info(`[导入] 歌单「${playlist.name}」去重：移除 ${removed} 条重复歌曲`)
            totalDeduplicated += removed
          }
          return { ...playlist, songs: uniqueSongs }
        })

        if (totalDeduplicated > 0) {
          console.info(`[导入] 共去重 ${totalDeduplicated} 条歌曲`)
        }

        const { importPlaylists } = await import('@/lib/api/playlists')
        console.info('[导入] v2 格式：调用后端批量导入接口...')
        const result = await importPlaylists(deduplicatedPlaylists as any)
        console.info(`[导入] 后端返回：成功 ${result.totalCreated} 个歌单，失败 ${result.failed.length} 个` +
          (result.failed.length > 0 ? `，失败明细: ${JSON.stringify(result.failed)}` : ''))
        await reload()
        const dedupMsg = totalDeduplicated > 0 ? `，已自动去重 ${totalDeduplicated} 条` : ''
        alert(`导入完成：成功 ${result.totalCreated} 个歌单${dedupMsg}，失败 ${result.failed.length} 个`)
        return
      }

      // Legacy format (version 1): only songIds, no musicInfo
      console.info('[导入] v1 旧格式（仅 songId）：逐个歌单前端导入...')
      let created = 0
      let failed = 0
      let idx = 0
      let totalDeduplicated = 0
      for (const item of data.playlists) {
        idx++
        const name = (item.name || '').trim() || '导入的歌单'
        try {
          console.info(`[导入] (${idx}/${data.playlists.length}) 歌单「${name}」开始处理`)
          const p = await create(name)
          const updates: { comment?: string; public?: boolean } = {}
          if (item.comment !== undefined) updates.comment = item.comment ?? undefined
          if (item.isPublic !== undefined) updates.public = item.isPublic
          if (Object.keys(updates).length > 0) await updatePlaylist(p.id, updates)
          const rawSongIds = (item.songs || []).map(s => s.songId).filter(Boolean)
          // 前端去重：同一歌单内 songId 去重
          const seen = new Set<string>()
          const songIds: string[] = []
          for (const sid of rawSongIds) {
            if (!seen.has(sid)) {
              seen.add(sid)
              songIds.push(sid)
            }
          }
          const removed = rawSongIds.length - songIds.length
          if (removed > 0) {
            console.info(`[导入] 歌单「${name}」去重：移除 ${removed} 条重复歌曲`)
            totalDeduplicated += removed
          }
          if (songIds.length > 0) await addSongsToPlaylist(p.id, songIds)
          created++
          console.info(`[导入] (${idx}/${data.playlists.length}) 歌单「${name}」导入成功，歌曲数=${songIds.length}`)
        } catch (err) {
          failed++
          console.error(`[导入] (${idx}/${data.playlists.length}) 歌单「${name}」导入失败:`, err)
        }
      }
      console.info(`[导入] 全部结束：成功 ${created} 个，失败 ${failed} 个`)
      await reload()
      const dedupMsg = totalDeduplicated > 0 ? `，已自动去重 ${totalDeduplicated} 条` : ''
      alert(`导入完成：成功 ${created} 个歌单${dedupMsg}，失败 ${failed} 个`)
    } catch (error) {
      console.error('[导入] 文件处理失败:', error)
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

  // 批量删除选中的歌单
  const handleBatchDelete = async () => {
    if (selectedIds.size === 0) return
    try {
      setBatchDeleting(true)
      const ids = Array.from(selectedIds)
      // 并行删除
      await Promise.all(ids.map(id => deletePlaylist(id)))
      // 从列表中移除
      setSelectedIds(new Set())
      // 刷新列表
      await reload()
      toast.success(`已删除 ${ids.length} 个歌单`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '删除失败')
    } finally {
      setBatchDeleting(false)
    }
  }

  // 切换单个歌单的选中状态
  const handleToggleSelect = useCallback((id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }, [])

  // 设置选中列表（用于框选和点击空白清空）
  const handleSetSelected = useCallback((ids: number[]) => {
    setSelectedIds(new Set(ids))
  }, [])

  /**
   * 合并选中的歌单：
   * 1. 逐个读取歌单歌曲（songId + musicInfo），按 songId 去重
   * 2. 调用后端批量导入接口一次性创建新歌单
   * 3. 创建成功后删除所有原歌单
   */
  const handleMerge = async (name: string) => {
    if (selectedIds.size < 2) return
    setMerging(true)
    console.info(`[合并] 开始：${selectedIds.size} 个歌单合并为「${name}」`)
    try {
      const ids = Array.from(selectedIds)
      const merged: ImportPlaylistSong[] = []
      const seen = new Set<string>()
      for (const p of playlists.filter(pl => ids.includes(pl.id))) {
        try {
          const detail = await getPlaylist(p.id)
          let count = 0
          for (const e of detail.entries || []) {
            if (!e.songId || seen.has(e.songId)) continue
            seen.add(e.songId)
            merged.push({ songId: e.songId, musicInfo: e.musicInfo as ImportPlaylistSong['musicInfo'] })
            count++
          }
          console.info(`[合并] 歌单「${p.name}」读取完成，新增歌曲=${count}`)
        } catch (err) {
          console.error(`[合并] 歌单「${p.name}」读取失败:`, err)
          throw new Error(`读取歌单「${p.name}」失败`)
        }
      }

      let playlistsLib
      try {
        playlistsLib = await import("@/lib/api/playlists")
      } catch (err) {
        console.error("[合并] 模块加载失败:", err)
        throw new Error("加载导入模块失败")
      }
      const result = await playlistsLib.importPlaylists([{ name, comment: null, isPublic: false, songs: merged }])
      if (result.failed.length > 0) {
        console.error('[合并] 新歌单创建失败:', result.failed)
        throw new Error(result.failed[0]?.error || '创建新歌单失败')
      }
      console.info(`[合并] 新歌单「${name}」创建成功（id=${result.created[0]?.id}），歌曲数=${merged.length}，开始删除原歌单`)

      // 合并成功后删除原歌单
      let deleted = 0
      const deleteErrors: string[] = []
      for (const id of ids) {
        const src = playlists.find(pl => pl.id === id)
        try {
          await deletePlaylist(id)
          deleted++
          console.info(`[合并] 原歌单「${src?.name ?? id}」已删除`)
        } catch (err) {
          console.error(`[合并] 原歌单「${src?.name ?? id}」删除失败:`, err)
          deleteErrors.push(src?.name ?? String(id))
        }
      }

      setSelectedIds(new Set())
      setShowMerge(false)
      await reload()
      console.info(`[合并] 完成：新歌单 1 个，删除原歌单 ${deleted}/${ids.length}`)
      if (deleteErrors.length > 0) {
        toast.error(`合并成功，但原歌单删除失败：${deleteErrors.join('、')}`)
      } else {
        toast.success(`已合并为「${name}」（${merged.length} 首），原 ${ids.length} 个歌单已删除`)
      }
    } catch (error) {
      console.error('[合并] 合并失败:', error)
      throw error instanceof Error ? error : new Error('合并失败')
    } finally {
      setMerging(false)
    }
  }

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="hidden text-2xl font-bold md:block">我的歌单</h1>
        <div className="flex flex-wrap items-center gap-2">
          {/* 排序选项 */}
          <div className="flex items-center gap-1 rounded-full border border-border px-2 py-1 text-sm">
            <span className="px-2 text-muted-foreground">排序:</span>
            <button
              onClick={() => { setSortField('name'); setSortAsc(true) }}
              className={`px-2 py-1 rounded transition hover:bg-muted ${sortField === 'name' && sortAsc ? 'bg-primary/15 text-primary' : ''}`}
            >
              名称↑
            </button>
            <button
              onClick={() => { setSortField('name'); setSortAsc(false) }}
              className={`px-2 py-1 rounded transition hover:bg-muted ${sortField === 'name' && !sortAsc ? 'bg-primary/15 text-primary' : ''}`}
            >
              名称↓
            </button>
            <button
              onClick={() => { setSortField('songCount'); setSortAsc(false) }}
              className={`px-2 py-1 rounded transition hover:bg-muted ${sortField === 'songCount' && !sortAsc ? 'bg-primary/15 text-primary' : ''}`}
            >
              歌曲数↓
            </button>
            <button
              onClick={() => { setSortField('createdAt'); setSortAsc(false) }}
              className={`px-2 py-1 rounded transition hover:bg-muted ${sortField === 'createdAt' && !sortAsc ? 'bg-primary/15 text-primary' : ''}`}
            >
              最新创建↓
            </button>
          </div>
          {/* 批量删除按钮 */}
          {selectedIds.size > 0 && (
            <button
              onClick={handleBatchDelete}
              disabled={batchDeleting}
              className="flex items-center gap-1 rounded-full bg-destructive/15 px-3 py-2 text-sm font-medium text-destructive transition hover:bg-destructive/25 disabled:opacity-50"
            >
              <Trash2 className="h-4 w-4" />
              {batchDeleting
                ? `删除中 ${selectedIds.size}/${playlists.length}`
                : `删除 (${selectedIds.size})`}
            </button>
          )}
          {/* 合并歌单（需选中 ≥2 个） */}
          {selectedIds.size >= 2 && (
            <button
              onClick={() => setShowMerge(true)}
              disabled={merging}
              className="flex items-center gap-1 rounded-full bg-primary/15 px-3 py-2 text-sm font-medium text-primary transition hover:bg-primary/25 disabled:opacity-50"
            >
              <Merge className="h-4 w-4" />
              {merging ? '合并中…' : `合并 (${selectedIds.size})`}
            </button>
          )}
          {selectedIds.size > 0 && (
            <button
              onClick={() => setSelectedIds(new Set())}
              className="flex items-center gap-1 rounded-full border border-border px-3 py-2 text-sm font-medium transition hover:bg-muted"
            >
              <CheckCheck className="h-4 w-4" /> 取消选择
            </button>
          )}
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

          {/* 歌单选择模式切换按钮 */}
          {selectedIds.size === 0 && !selectMode ? (
            <button
              onClick={() => setSelectMode(true)}
              className="flex items-center gap-1 rounded-full border border-border px-3 py-2 text-sm font-medium transition hover:bg-muted"
            >
              <CheckCheck className="h-4 w-4" /> 选择歌单
            </button>
          ) : (
            <div className="flex flex-col gap-2">
              {/* 取消选择按钮 */}
              <button
                onClick={() => {
                  setSelectMode(false)
                  setSelectedIds(new Set())
                }}
                className="flex items-center gap-1 rounded-full border border-border px-3 py-2 text-sm font-medium transition hover:bg-muted"
              >
                <CheckCheck className="h-4 w-4" /> 取消选择
              </button>
              {/* 批量操作按钮 */}
              {selectedIds.size > 0 && (
                <div className="flex gap-2">
                  {/* 删除按钮 */}
                  <button
                    onClick={handleBatchDelete}
                    disabled={batchDeleting || selectedIds.size === 0}
                    className="flex items-center gap-1 rounded-full bg-destructive/15 px-3 py-2 text-sm font-medium text-destructive transition hover:bg-destructive/25 disabled:opacity-50"
                  >
                    <Trash2 className="h-4 w-4" />
                    {batchDeleting
                      ? `删除中 ${selectedIds.size}/${playlists.length}`
                      : `删除 (${selectedIds.size})`}
                  </button>
                  {/* 合并按钮（需选中 ≥2 个） */}
                  {selectedIds.size >= 2 && (
                    <button
                      onClick={() => setShowMerge(true)}
                      disabled={merging}
                      className="flex items-center gap-1 rounded-full bg-primary/15 px-3 py-2 text-sm font-medium text-primary transition hover:bg-primary/25 disabled:opacity-50"
                    >
                      <Merge className="h-4 w-4" />
                      {merging ? '合并中…' : `合并 (${selectedIds.size})`}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
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
          playlists={sortedPlaylists}
          currentUsername={currentUsername}
          onEdit={setEditingPlaylist}
          onDelete={setDeletingPlaylist}
          onDownload={handleDownloadPlaylist}
          multiSelect={selectMode || selectedIds.size > 0}
          selectedIds={selectedIds}
          onToggleSelect={handleToggleSelect}
          onSelectAll={handleSetSelected}
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

      {/* 下载队列 —— 显示当前正在下载的队列 */}
      {queue.tasks.length > 0 && (
        <section className="mt-8">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Download className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-lg font-semibold">下载队列</h2>
              {queue.running && (
                <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-xs text-primary">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  进行中 {queue.doneCount}/{queue.tasks.length}
                </span>
              )}
            </div>
            {queue.running && (
              <button
                onClick={queue.cancel}
                className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground"
              >
                <XCircle className="h-3 w-3" />
                取消
              </button>
            )}
          </div>

          <ul className="divide-y divide-border rounded-lg border border-border">
            {queue.tasks.map(task => (
              <li key={task.uid} className="flex items-center gap-3 px-3 py-2 text-sm">
                {task.status === 'downloading' && (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
                )}
                {task.status === 'done' && (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-green-500" />
                )}
                {task.status === 'failed' && (
                  <XCircle className="h-4 w-4 shrink-0 text-destructive" />
                )}
                {task.status === 'pending' && (
                  <span className="h-4 w-4 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate" title={task.name}>
                  {task.name}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {task.quality}
                </span>
                {task.status === 'failed' && task.reason && (
                  <span className="shrink-0 text-xs text-destructive" title={task.reason}>
                    失败
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

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

      {showMerge && (
        <MergePlaylistDialog
          count={selectedIds.size}
          onClose={() => setShowMerge(false)}
          onMerge={handleMerge}
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
