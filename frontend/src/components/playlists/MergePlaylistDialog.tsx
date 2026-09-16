
import { useState } from 'react'
import { X } from 'lucide-react'

interface Props {
  /** 参与合并的歌单数 */
  count: number
  onClose: () => void
  /** 确认合并（name 为新歌单名称） */
  onMerge: (name: string) => Promise<void>
}

/**
 * 歌单合并命名弹窗：
 * 输入新歌单名称，合并成功后原歌单将被删除。
 */
export function MergePlaylistDialog({ count, onClose, onMerge }: Props) {
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      await onMerge(name.trim())
    } catch (err) {
      setError(err instanceof Error ? err.message : '合并失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-sm rounded-lg bg-card p-6 shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">合并歌单</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-5 w-5" />
          </button>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">
          将选中的 {count} 个歌单合并为一个新歌单；合并成功后，原歌单将被删除。
        </p>
        <form onSubmit={submit}>
          <input
            autoFocus
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="新歌单名称"
            className="mb-4 w-full rounded-md bg-background px-3 py-2 text-sm outline-none ring-1 ring-border focus:ring-primary"
          />
          {error && (
            <p className="mb-3 text-sm text-destructive">{error}</p>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-full px-4 py-2 text-sm text-muted-foreground hover:text-foreground"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={!name.trim() || submitting}
              className="rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {submitting ? '合并中…' : '合并'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
