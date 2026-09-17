import { useState } from 'react'
import { usePlayerStore } from '@/lib/store/player-store'
import { useFavoritesStore } from '@/lib/store/favorites-store'
import { useContextMenuStore } from '@/lib/store/context-menu-store'
import { useAuthStore } from '@/hooks/useAuth'
import { useDownload } from '@/hooks/useDownload'
import { useLongPress } from '@/hooks/useLongPress'
import { useDownloadStatus } from '@@/hooks/useDownloadStatus'
import { CoverImage } from './CoverImage'
import { SourceBadge } from './SourceBadge'
import { QualityBadge } from './QualityBadge'
import { Play, Pause, Heart, MoreHorizontal, Download, Loader2, CheckCircle, RefreshCw } from 'lucide-react'
import { formatTime } from '@/lib/utils/format'
import { resolveQuality } from '@/lib/quality-options'
import type { Track } from '@/lib/types/player'
import type { MusicInfo } from '@/lib/types/music'
import { SourceReplacePanel } from '../../frontend/src/components/shared/SourceReplacePanel'

interface SongRowProps {
  track: Track
  queue?: Track[]
  index?: number
  /** 所属歌单 id；传入后右键菜单会显示「移出歌单」 */
  playlistId?: number
}

export function SongRow({ track, queue, index, playlistId }: SongRowProps) {
  const currentTrack = usePlayerStore(s => s.currentTrack)
  const isPlaying = usePlayerStore(s => s.isPlaying)
  const playTrack = usePlayerStore(s => s.playTrack)
  const isFav = useFavoritesStore(s => s.ids.has(track.uid))
  const toggleFav = useFavoritesStore(s => s.toggle)
  const openMenu = useContextMenuStore(s => s.openMenu)
  const authenticated = useAuthStore(s => s.authenticated)
  const { download, downloading, error } = useDownload()
  // 查询下载状态
  const { isDownloaded } = useDownloadStatus([track.uid])
  const downloaded = isDownloaded(track.uid)
  const [showReplace, setShowReplace] = useState(false)

  const isCurrent = currentTrack?.uid === track.uid
  const isCurrentPlaying = isCurrent && isPlaying

  // 触屏长按呼出操作菜单（Spotify/网易云同款），桌面走右键/hover"⋯"
  const longPress = useLongPress((x, y) => openMenu(track, x, y, playlistId))

  const handlePlay = () => {
    if (isCurrent) {
      usePlayerStore.getState().togglePlay()
    } else {
      playTrack(track, queue)
    }
  }

  return (
    <div
      onContextMenu={e => {
        e.preventDefault()
        openMenu(track, e.clientX, e.clientY, playlistId)
      }}
      {...longPress}
      // 触屏禁用长按文本选择/iOS 放大镜（桌面不受影响）
      className={`group flex items-center gap-3 rounded-md px-2 py-2 pointer-coarse:select-none pointer-coarse:[-webkit-touch-callout:none] ${
        isCurrent ? 'bg-accent/50' : 'hover:bg-accent/30'
      }`}
    >
      {/* 序号 / 播放按钮 */}
      <div className="flex w-6 shrink-0 items-center justify-center text-sm text-muted-foreground">
        {isCurrentPlaying ? (
          <button onClick={handlePlay} aria-label="暂停">
            <Pause className="h-4 w-4 fill-current text-primary" />
          </button>
        ) : (
          <>
            <span className={`group-hover:hidden ${isCurrent ? 'text-primary' : ''}`}>
              {index != null ? index + 1 : '♪'}
            </span>
            <button onClick={handlePlay} className="hidden group-hover:block" aria-label="播放">
              <Play className="h-4 w-4 fill-current" />
            </button>
          </>
        )}
      </div>

      <button onClick={handlePlay} className="shrink-0">
        <CoverImage uid={track.uid} cacheKey={track.musicInfo.img} className="h-10 w-10" />
      </button>

      <button onClick={handlePlay} className="min-w-0 flex-1 text-left">
        <div className={`flex items-center gap-2 ${isCurrent ? 'text-primary' : ''}`}>
          <span className="truncate text-sm font-medium">{track.name}</span>
          <QualityBadge musicInfo={track.musicInfo} />
          {authenticated && (
            <button
              onClick={(e) => { e.stopPropagation(); setShowReplace(true) }}
              className="shrink-0 rounded p-0.5 text-muted-foreground/50 transition hover:bg-accent hover:text-foreground"
              title="更换音源"
              aria-label="更换音源"
            >
              <RefreshCw className="h-3 w-3" />
            </button>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-2">
          <span className="truncate text-xs text-muted-foreground">{track.artist}</span>
          <SourceBadge source={track.source} />
        </div>
      </button>

      <span className="hidden w-32 shrink-0 truncate text-xs text-muted-foreground sm:block">
        {track.album}
      </span>

      <button
        onClick={() => toggleFav(track.uid).catch(() => {})}
        // 触屏扩大命中区（视觉不变，24px→40px，负 margin 抵消布局膨胀；HIG 44pt 标准）
        className={`shrink-0 p-1 transition pointer-coarse:p-3 pointer-coarse:-m-1.5 ${
          isFav
            ? 'text-primary'
            : 'text-muted-foreground opacity-70 hover:text-foreground focus-visible:opacity-100 pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100'
        }`}
        aria-label="收藏"
      >
        <Heart className={`h-4 w-4 ${isFav ? 'fill-current' : ''}`} />
      </button>

      {authenticated && (
        <button
          onClick={() =>
            download({
              uid: track.uid,
              quality: resolveQuality(usePlayerStore.getState().quality, track.musicInfo.types),
            })
          }
          disabled={downloading}
          className={`hidden shrink-0 p-1 transition md:block ${
            downloading
              ? 'text-primary opacity-100'
              : downloaded
                ? 'text-green-500 opacity-100 cursor-default'
                : 'text-muted-foreground opacity-70 hover:text-foreground focus-visible:opacity-100 pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100'
          } disabled:opacity-100`}
          aria-label={downloaded ? '已下载' : '下载'}
          title={downloaded ? '已下载到本地' : (error ?? '下载')}
        >
          {downloading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : downloaded ? (
            <CheckCircle className="h-4 w-4" />
          ) : (
            <Download className="h-4 w-4" />
          )}
        </button>
      )}

      <button
        onClick={e => {
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
          openMenu(track, rect.right, rect.bottom, playlistId)
        }}
        // 手机常显（触屏无 hover，pointer-fine 不匹配即回落 opacity-70），桌面 hover 显现；
        // 触屏扩大命中区（视觉不变，24px→40px），与收藏按钮命中区不重叠
        className="shrink-0 p-1 text-muted-foreground opacity-70 hover:text-foreground focus-visible:opacity-100 pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-coarse:p-3 pointer-coarse:-m-1.5"
        aria-label="更多操作"
        title="更多操作"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>

      <span className="w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {formatTime(track.duration)}
      </span>

      {showReplace && (
        <SourceReplacePanel
          track={{
            uid: track.uid,
            name: track.name,
            artist: track.artist,
            musicInfo: track.musicInfo,
          }}
          onClose={() => setShowReplace(false)}
          onSwitch={(newMusicInfo) => {
            // 更新当前播放的歌曲音源
            const current = usePlayerStore.getState().currentTrack
            if (current?.uid === track.uid) {
              usePlayerStore.setState(s => ({
                ...s,
                currentTrack: { ...current, musicInfo: newMusicInfo }
              }))
            }
            // 广播事件，通知父组件更新数据
            window.dispatchEvent(new CustomEvent('song-source-changed', {
              detail: { uid: track.uid, musicInfo: newMusicInfo }
            }))
          }}
        />
      )}
    </div>
  )
}
