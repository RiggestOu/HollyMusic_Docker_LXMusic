import { useState, useRef, type ChangeEvent } from 'react'
import { ListMusic, Plus, Sparkles, Download, Upload } from 'lucide-react'
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
        />
      ) : (
        <EmptyState icon={ListMusic} title="还没有歌单" description="新建一个歌单开始整理" />
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
    </div>
  )
}
