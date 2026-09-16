import { useState, useEffect, useCallback } from 'react'

interface DownloadStatus {
  uid: string
  downloaded: boolean
  filename?: string
  quality?: string
}

export function useDownloadStatus(uids: string[]) {
  const [statuses, setStatuses] = useState<Map<string, DownloadStatus>>(new Map())
  const [loading, setLoading] = useState(false)

  const fetchStatuses = useCallback(async (uidsToFetch: string[]) => {
    if (uidsToFetch.length === 0) return
    setLoading(true)
    try {
      // 批量查询：先获取所有已下载的 uid
      const res = await fetch('/api/download-status')
      if (!res.ok) return
      const data = await res.json() as { uids?: string[] }
      const downloadedSet = new Set(data.uids || [])
      
      const newStatuses = new Map(statuses)
      uidsToFetch.forEach(uid => {
        newStatuses.set(uid, {
          uid,
          downloaded: downloadedSet.has(uid),
        })
      })
      setStatuses(newStatuses)
    } finally {
      setLoading(false)
    }
  }, [statuses])

  const isDownloaded = useCallback((uid: string): boolean => {
    return statuses.get(uid)?.downloaded || false
  }, [statuses])

  useEffect(() => {
    if (uids.length > 0) {
      fetchStatuses(uids)
    }
  }, [uids, fetchStatuses])

  return { statuses, loading, isDownloaded, refresh: () => fetchStatuses(uids) }
}
