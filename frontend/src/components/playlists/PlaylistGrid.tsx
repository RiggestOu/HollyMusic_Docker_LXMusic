
import { useEffect, useRef, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import type { PlaylistSummary } from '@/lib/api/playlists'
import { MoreHorizontal, Pencil, Trash2, Download, Check } from 'lucide-react'
import { PlaylistCover } from './PlaylistCover'

interface Props {
  playlists: PlaylistSummary[]
  currentUsername: string | null
  onEdit: (playlist: PlaylistSummary) => void
  onDelete: (playlist: PlaylistSummary) => void
  /** 下载该歌单的全部歌曲（未下载的才会落盘） */
  onDownload?: (playlist: PlaylistSummary) => void
  /** 批量选中模式 */
  multiSelect?: boolean
  /** 已选中的歌单 ID 列表 */
  selectedIds?: Set<number>
  /** 切换选中状态 */
  onToggleSelect?: (id: number) => void
  /** 清空选中 */
  onSelectAll?: (ids: number[]) => void
}

interface SelectionRect {
  x: number
  y: number
  width: number
  height: number
}

export function PlaylistGrid({
  playlists,
  currentUsername,
  onEdit,
  onDelete,
  onDownload,
  multiSelect = false,
  selectedIds = new Set(),
  onToggleSelect,
  onSelectAll,
}: Props) {
  const [openMenuId, setOpenMenuId] = useState<number | null>(null)
  const gridRef = useRef<HTMLDivElement>(null)

  // 框选状态
  const [isSelecting, setIsSelecting] = useState(false)
  const [selectionRect, setSelectionRect] = useState<SelectionRect | null>(null)
  const dragStartRef = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    const closeMenu = (event: MouseEvent) => {
      if (!gridRef.current?.contains(event.target as Node)) setOpenMenuId(null)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenMenuId(null)
    }
    document.addEventListener('mousedown', closeMenu)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeMenu)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [])

  // 处理鼠标按下开始框选
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // 只在空白区域开始框选
    if ((e.target as HTMLElement).closest('.playlist-card')) return
    if (e.button !== 0) return // 只处理左键

    const rect = gridRef.current?.getBoundingClientRect()
    if (!rect) return

    dragStartRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    setIsSelecting(true)
    setSelectionRect({ x: dragStartRef.current.x, y: dragStartRef.current.y, width: 0, height: 0 })
  }, [])

  // 处理鼠标移动更新框选区域
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isSelecting || !dragStartRef.current) return

    const rect = gridRef.current?.getBoundingClientRect()
    if (!rect) return

    const x = e.clientX - rect.left
    const y = e.clientY - rect.top

    setSelectionRect({
      x: Math.min(dragStartRef.current.x, x),
      y: Math.min(dragStartRef.current.y, y),
      width: Math.abs(x - dragStartRef.current.x),
      height: Math.abs(y - dragStartRef.current.y),
    })
  }, [isSelecting])

  // 处理鼠标释放完成框选
  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    if (!isSelecting || !selectionRect || !dragStartRef.current) {
      setIsSelecting(false)
      dragStartRef.current = null
      return
    }

    // 如果拖动距离太小，视为点击
    const dist = Math.sqrt(
      Math.pow(e.clientX - (dragStartRef.current.x + (selectionRect.x)), 2) +
      Math.pow(e.clientY - (dragStartRef.current.y + (selectionRect.y)), 2)
    )

    if (dist < 5) {
      // 单击：切换选中状态
      const target = e.target as HTMLElement
      const card = target.closest('.playlist-card') as HTMLElement
      if (card) {
        const id = Number(card.dataset.id)
        if (!isNaN(id) && onToggleSelect) {
          if (e.ctrlKey || e.metaKey) {
            onToggleSelect(id)
          } else {
            onSelectAll?.([id])
          }
        }
      } else if (!e.ctrlKey && !e.metaKey) {
        // 点击空白区域且未按 Ctrl，清空选中
        onSelectAll?.([])
      }
    } else {
      // 框选：计算选中的歌单
      const gridRect = gridRef.current?.getBoundingClientRect()
      if (!gridRect) return

      const selected: number[] = []
      playlists.forEach(playlist => {
        const card = gridRef.current?.querySelector(`[data-id="${playlist.id}"]`) as HTMLElement
        if (!card) return

        const cardRect = card.getBoundingClientRect()
        const overlap = !(
          selectionRect.x + selectionRect.width < cardRect.left - gridRect.left ||
          selectionRect.x > cardRect.right - gridRect.left ||
          selectionRect.y + selectionRect.height < cardRect.top - gridRect.top ||
          selectionRect.y > cardRect.bottom - gridRect.top
        )

        if (overlap) {
          selected.push(playlist.id)
        }
      })

      if (e.ctrlKey || e.metaKey) {
        // Ctrl+框选：在已有选中基础上对框内歌单逐一切换（不可变更新，一次性提交）
        const next = new Set(selectedIds)
        for (const id of selected) {
          if (next.has(id)) {
            next.delete(id)
          } else {
            next.add(id)
          }
        }
        onSelectAll?.([...next])
      } else {
        // 普通框选：选中列表替换为框内歌单
        onSelectAll?.(selected)
      }
    }

    setIsSelecting(false)
    setSelectionRect(null)
    dragStartRef.current = null
  }, [isSelecting, selectionRect, playlists, selectedIds, onToggleSelect, onSelectAll])

  return (
    <div
      ref={gridRef}
      className={`grid grid-cols-2 gap-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 ${multiSelect ? 'relative select-none' : ''}`}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      {/* 框选矩形 */}
      {isSelecting && selectionRect && (
        <div
          className="absolute pointer-events-none border border-blue-500 bg-blue-500/20 z-50"
          style={{
            left: selectionRect.x,
            top: selectionRect.y,
            width: selectionRect.width,
            height: selectionRect.height,
          }}
        />
      )}

      {playlists.map(playlist => {
        const isSelected = selectedIds.has(playlist.id)
        return (
          <div
            key={playlist.id}
            data-id={playlist.id}
            className={`playlist-card group relative rounded-lg p-2 hover:bg-accent/40 transition-colors ${isSelected ? 'bg-blue-500/20 ring-2 ring-blue-500' : ''}`}
            // 右键直接呼出操作菜单（与 ⋯ 按钮同一个菜单）
            onContextMenu={e => {
              if (playlist.username !== currentUsername) return
              e.preventDefault()
              setOpenMenuId(playlist.id)
            }}
          >
            {/* 左下角复选框 */}
            {multiSelect && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  e.preventDefault()
                  onToggleSelect?.(playlist.id)
                }}
                className={`absolute bottom-2 left-2 z-10 h-5 w-5 rounded border-2 flex items-center justify-center transition ${
                  isSelected
                    ? 'bg-primary border-primary text-primary-foreground'
                    : 'border-muted-foreground/40 bg-background/80 hover:border-primary'
                }`}
                aria-label={isSelected ? '取消选中' : '选中歌单'}
              >
                {isSelected && <Check className="h-3 w-3" />}
              </button>
            )}
            <Link to={`/playlists/${playlist.id}`} className="flex flex-col gap-2" onClick={e => {
              if (!multiSelect) return
              // Ctrl/Cmd+点击：切换选中且不跳转详情页
              if (e.ctrlKey || e.metaKey) {
                e.preventDefault()
                e.stopPropagation()
                onToggleSelect?.(playlist.id)
              }
            }}>
              <PlaylistCover
                coverArt={playlist.coverArt}
                coverSongUid={playlist.coverSongUid}
                className="aspect-square w-full"
              />
              <div className="truncate text-sm font-medium">{playlist.name}</div>
              <div className="pr-8 text-xs text-muted-foreground">{playlist.songCount} 首</div>
            </Link>

            {playlist.username === currentUsername && (
              <>
                <button
                  type="button"
                  aria-label={`操作歌单：${playlist.name}`}
                  aria-expanded={openMenuId === playlist.id}
                  onClick={(e) => {
                    e.stopPropagation()
                    setOpenMenuId(id => id === playlist.id ? null : playlist.id)
                  }}
                  className="absolute bottom-2 right-2 rounded p-1 text-muted-foreground opacity-100 transition hover:bg-accent hover:text-foreground sm:opacity-0 sm:focus:opacity-100 sm:group-hover:opacity-100"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </button>

                {openMenuId === playlist.id && (
                  <div className="absolute bottom-9 right-2 z-10 w-32 rounded-md border border-border bg-popover p-1 shadow-lg">
                    <button
                      type="button"
                      onClick={() => {
                        setOpenMenuId(null)
                        onDownload?.(playlist)
                      }}
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                    >
                      <Download className="h-3.5 w-3.5" /> 下载歌单歌曲
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setOpenMenuId(null)
                        onEdit(playlist)
                      }}
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                    >
                      <Pencil className="h-3.5 w-3.5" /> 编辑
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setOpenMenuId(null)
                        onDelete(playlist)
                      }}
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-destructive hover:bg-destructive/10"
                    >
                      <Trash2 className="h-3.5 w-3.5" /> 删除
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}
