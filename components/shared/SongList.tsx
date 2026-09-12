
import { SongRow } from './SongRow'
import type { Track } from '@/lib/types/player'

interface SongListProps {
  tracks: Track[]
  /** 所属歌单 id；传入后每行右键菜单会显示「移出歌单」 */
  playlistId?: number
}

export function SongList({ tracks, playlistId }: SongListProps) {
  if (tracks.length === 0) return null
  return (
    <div className="flex flex-col">
      {tracks.map((t, i) => (
        <SongRow
          key={`${t.uid}-${i}`}
          track={t}
          queue={tracks}
          index={i}
          playlistId={playlistId}
        />
      ))}
    </div>
  )
}
