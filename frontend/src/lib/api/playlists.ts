/**
 * 歌单 API
 */

import { apiGet, apiPost, apiPatch, apiDelete } from './client'
import type { MusicInfo } from '@/lib/types/music'

export interface PlaylistSummary {
  id: number
  name: string
  comment: string | null
  owner: string | null
  username: string
  isPublic: boolean
  songCount: number
  duration: number | null
  coverArt: string | null
  coverSongUid: string | null
  createdAt: string
}

export interface PlaylistEntryItem {
  position: number
  songId: string
  musicInfo: MusicInfo | null
  addedAt: string
  addedBy: string | null
}

export interface PlaylistDetail extends PlaylistSummary {
  entries: PlaylistEntryItem[]
  allowedUsers: string[]
}

export function listPlaylists(): Promise<{ list: PlaylistSummary[] }> {
  return apiGet('playlists')
}

export function getPlaylist(id: number): Promise<PlaylistDetail> {
  return apiGet(`playlists/${id}`)
}

export function createPlaylist(name: string): Promise<PlaylistSummary> {
  return apiPost('playlists', { name })
}

export function updatePlaylist(
  id: number,
  updates: { name?: string; comment?: string; public?: boolean }
): Promise<{ updated: boolean }> {
  return apiPatch(`playlists/${id}`, updates)
}

export function deletePlaylist(id: number): Promise<{ deleted: boolean }> {
  return apiDelete(`playlists/${id}`)
}

export function addSongsToPlaylist(
  id: number,
  songIds: string[]
): Promise<{ added: boolean }> {
  return apiPost(`playlists/${id}/songs`, { songIds })
}

/**
 * 导入歌单（含 musicInfo）
 */
export interface ImportPlaylistSong {
  songId: string
  musicInfo: MusicInfo
}

export interface ImportPlaylist {
  name: string
  comment?: string | null
  isPublic?: boolean
  songs: ImportPlaylistSong[]
}

export interface ImportResult {
  created: Array<{ id: number; name: string; count: number }>
  failed: Array<{ name: string; error: string }>
  totalCreated: number
}

export function importPlaylists(playlists: ImportPlaylist[]): Promise<ImportResult> {
  return apiPost('playlists/import', { playlists })
}

/**
 * 从文件导入歌单（读取 JSON 后调用 API）
 */
export async function importPlaylistsFromFile(file: File): Promise<{ success: number; failed: number }> {
  const text = await file.text()
  const data = JSON.parse(text) as { playlists: ImportPlaylist[] }
  if (!data || !Array.isArray(data.playlists)) throw new Error('文件格式不正确')
  
  const result = await importPlaylists(data.playlists)
  return {
    success: result.totalCreated,
    failed: result.failed.length
  }
}

export function removeSongsFromPlaylist(
  id: number,
  positions: number[]
): Promise<{ removed: boolean }> {
  return apiDelete(`playlists/${id}/songs`, { positions: positions.join(',') })
}
