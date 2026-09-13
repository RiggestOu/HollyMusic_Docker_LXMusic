/**
 * 桌面歌词页（路由 `/lyrics`）。
 *
 * 由 Tauri 外壳在「透明 + 置顶 + 默认鼠标穿透」的独立窗口中加载。
 * 数据来源（二选一，前者优先）：
 *   1. 主窗口经 IPC 主动推送的歌词（`hm:lyrics`）；
 *   2. 主窗口只推送播放状态（`hm:playback`，含 uid 与播放进度）时，
 *      本页自己调用歌词接口并复用 Web 端相同的解析/定位逻辑。
 *
 * 与桌面壁纸一样，这一页不参与登录守卫、不渲染任何导航与播控，
 * 以保证窗口可以做得足够小、足够轻。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { getLyrics } from '@/lib/api/lyrics'
import { parseLrc, parsePlainText, findActiveLineIndex } from '@/lib/utils/lrc'
import { desktopOn } from '@/lib/client/desktop-bridge'

interface PlaybackState {
  uid?: string
  title?: string
  artist?: string
  position?: number
  duration?: number
  isPlaying?: boolean
}

interface PushedLyricLine {
  time?: number
  text?: string
}

export function DesktopLyricsPage() {
  const [playback, setPlayback] = useState<PlaybackState | null>(null)
  const [pushed, setPushed] = useState<PushedLyricLine[] | null>(null)
  const [raw, setRaw] = useState<{ lyric: string | null; tlyric: string | null } | null>(null)
  // 平滑推进的显示进度：避免 IPC 4Hz 推送导致歌词跳变（缓动到目标值）
  const smoothPos = useRef(0)

  useEffect(() => {
    const stops = [
      desktopOn<PlaybackState | null>('playback', detail => detail && setPlayback(detail)),
      desktopOn<PushedLyricLine[] | null>('lyrics', detail => {
        setPushed(Array.isArray(detail) ? detail : null)
      }),
    ]
    // 让窗口底色完全透明，只留下文字
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
    return () => {
      stops.forEach(stop => stop())
      document.documentElement.style.background = ''
      document.body.style.background = ''
    }
  }, [])

  const uid = playback?.uid
  useEffect(() => {
    if (!uid || pushed) return
    let cancelled = false
    getLyrics(uid)
      .then(d => {
        if (!cancelled) setRaw({ lyric: d.lyric, tlyric: d.tlyric })
      })
      .catch(() => {
        if (!cancelled) setRaw(null)
      })
    return () => {
      cancelled = true
    }
  }, [uid, pushed])

  const lines = useMemo(() => {
    if (pushed) {
      return pushed.map(l => ({ time: l.time ?? 0, text: l.text ?? '' }))
    }
    const timed = parseLrc(raw?.lyric)
    return timed.length > 0 ? timed : parsePlainText(raw?.lyric)
  }, [pushed, raw?.lyric])

  const translated = useMemo(
    () => (pushed ? [] : parseLrc(raw?.tlyric)),
    [pushed, raw?.tlyric],
  )

  // IPC 推送频率有限，这里对进度做缓动，保证歌词滚动是连续的而不是跳格的
  const target = playback?.position ?? 0
  useEffect(() => {
    let raf = 0
    const step = () => {
      smoothPos.current += (target - smoothPos.current) * 0.18
      if (Math.abs(target - smoothPos.current) > 0.01) raf = requestAnimationFrame(step)
      else smoothPos.current = target
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [target])

  const [index, setIndex] = useState(0)
  useEffect(() => {
    let raf = 0
    const tick = () => {
      setIndex(findActiveLineIndex(lines, smoothPos.current))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [lines])

  const current = lines[index]
  const translatedText =
    translated.length > index && translated[index] ? translated[index].text : ''

  if (!playback || !current) {
    // 没有播放内容时保持空白，避免出现黑色方块遮挡桌面
    return <div className="h-screen w-screen" />
  }

  return (
    <div className="flex h-screen w-screen select-none items-end justify-center px-8 pb-6">
      <div className="w-full text-center">
        <div
          className="transition-all duration-500"
          style={{ opacity: 1 }}
        >
          <p
            className="text-[28px] font-semibold leading-snug text-white"
            style={{ textShadow: '0 2px 12px rgba(0,0,0,0.55)' }}
          >
            {current.text}
          </p>
          {translatedText ? (
            <p
              className="mt-1 text-[18px] text-white/70"
              style={{ textShadow: '0 2px 12px rgba(0,0,0,0.55)' }}
            >
              {translatedText}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  )
}
