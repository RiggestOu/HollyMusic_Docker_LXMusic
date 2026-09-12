/**
 * 右键/长按歌曲菜单状态（zustand）。
 * 用全局 store 而非 React state，避免跨组件状态提升和 portal：
 * SongRow/首页卡片 的 onContextMenu、useLongPress 调 openMenu，App.tsx 顶层渲染一次 <SongContextMenu />。
 */

import { create } from 'zustand'
import type { Track } from '@/lib/types/player'

/** 刚打开的菜单在保护期内忽略 close：吞掉长按松手后个别浏览器仍合成的 click/mousedown
 *  （与 useLongPress 的 touchend preventDefault 双保险，防止菜单闪关） */
const OPEN_GUARD_MS = 350

interface MenuState {
  /** playlistId：仅当歌曲在「歌单详情」中被右键时携带，用于显示「移出歌单」 */
  menu: { track: Track; x: number; y: number; openedAt: number; playlistId?: number } | null
  openMenu: (track: Track, x: number, y: number, playlistId?: number) => void
  close: () => void
}

export const useContextMenuStore = create<MenuState>((set, get) => ({
  menu: null,
  openMenu: (track, x, y, playlistId) =>
    set({ menu: { track, x, y, openedAt: Date.now(), playlistId } }),
  close: () => {
    const m = get().menu
    if (m && Date.now() - m.openedAt < OPEN_GUARD_MS) return
    set({ menu: null })
  },
}))
