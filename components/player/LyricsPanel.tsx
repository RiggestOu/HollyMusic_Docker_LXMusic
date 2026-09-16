
import { useEffect, useMemo, useRef, useState } from 'react'
import { usePlayerStore } from '@/lib/store/player-store'
import { useFavoritesStore } from '@/lib/store/favorites-store'
import { useDownload } from '@/hooks/useDownload'
import { useFxSettingsStore, resolveFx } from '@/lib/store/fx-settings-store'
import {
  PRESETS,
  PRESET_CHANGED_EVENT,
  clampPreset,
  loadStoredPreset,
  storePreset,
} from '@/lib/client/particle/presets'
import { loadStoredCustomImage } from '@/lib/client/particle/custom-image'
import { buildCoverUrl } from '@/lib/api/music'
import { Sparkles } from 'lucide-react'
import { pickHighestQuality } from '@/hooks/useDownloadQueue'
import { useLyrics } from '@/hooks/useLyrics'
import { isMobileLike } from '@/lib/utils/device'
import { CoverImage } from '@/components/shared/CoverImage'
import { AudioSpectrum } from './AudioSpectrum'
import { ParticleScene } from './ParticleScene'
import { ParticleSettingsPanel, LYRICS_MODE_CHANGED_EVENT } from './FxSettingsPanel'
import { ParticleTuningPanel } from './ParticleTuningPanel'
import type { LucideIcon } from 'lucide-react'
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Loader2,
  AlignJustify,
  Layers,
  Type,
  Repeat,
  Repeat1,
  Shuffle,
  Heart,
  Download,
  X,
  Settings,
  FlaskConical,
} from 'lucide-react'

interface LyricsPanelProps {
  audio: HTMLAudioElement | null
}

/**
 * 歌词显示模式：
 *   tile   —— 平铺视窗（默认）：多行列居中滚动铺满
 *   plane  —— 贴合粒子平面（MineRadio 风）：CSS 3D 透视让歌词「贴」在粒子平面上，
 *             当前句凸出（translateZ 最大），整面随镜头缓慢摆动
 *   single —— 单行悬浮：底部频谱 canvas 上方单行大字，随播放逐行淡入切换
 */
type LyricsMode = 'tile' | 'plane' | 'single'

const MODE_ORDER: LyricsMode[] = ['tile', 'plane', 'single']

const MODE_META: Record<LyricsMode, { label: string; icon: LucideIcon }> = {
  tile: { label: '平铺', icon: AlignJustify },
  plane: { label: '贴合粒子', icon: Layers },
  single: { label: '单行', icon: Type },
}

function loadLyricsMode(): LyricsMode {
  try {
    const v = localStorage.getItem('lyrics-display-mode')
    return v === 'plane' || v === 'single' ? v : 'tile'
  } catch {
    return 'tile'
  }
}

function saveLyricsMode(m: LyricsMode) {
  try {
    localStorage.setItem('lyrics-display-mode', m)
  } catch {
    /* 隐私模式等场景写入失败可忽略 */
  }
}

export function LyricsPanel({ audio }: LyricsPanelProps) {
  const isOpen = usePlayerStore(s => s.isLyricsOpen)
  const setLyricsOpen = usePlayerStore(s => s.setLyricsOpen)
  const track = usePlayerStore(s => s.currentTrack)
  const currentTime = usePlayerStore(s => s.currentTime)
  const duration = usePlayerStore(s => s.duration)
  const isPlaying = usePlayerStore(s => s.isPlaying)
  const bufferProgress = usePlayerStore(s => s.bufferProgress)
  const togglePlay = usePlayerStore(s => s.togglePlay)
  const next = usePlayerStore(s => s.next)
  const previous = usePlayerStore(s => s.previous)
  const seek = usePlayerStore(s => s.seek)
  // 底部条新增：循环模式 + 收藏
  const playbackMode = usePlayerStore(s => s.playbackMode)
  const cyclePlaybackMode = usePlayerStore(s => s.cyclePlaybackMode)
  const isFav = useFavoritesStore(s => (track ? s.ids.has(track.uid) : false))
  const toggleFavorite = useFavoritesStore(s => s.toggle)
  // 下载：复用既有 useDownload（同步构造 /api/download?uid=... → 原生下载管理器），
  // quality 省略时后端默认 320k
  const { download, downloading } = useDownload()

  // 13 种视觉预设（与粒子设置卡共用同一份数据源与持久化）
  const [preset, setPreset] = useState(() => loadStoredPreset())
  /** 实际生效的渲染后端（WebGPU / WebGL 2.0），由 ParticleScene 回报 */
  const [backend, setBackend] = useState<string | null>(null)
  /** 相机旋转补偿：歌词平面反向旋转以跟踪粒子封面 */
  const [cameraRot, setCameraRot] = useState({ elevationDeg: 0, yawDeg: 0 })
  /** 粒子设置面板（预设 + 动效统一）开合 */
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** 实验调参面板（debug 专用，独立于设置面板） */
  const [tuningOpen, setTuningOpen] = useState(false)
  /** 当前动效参数（来自全局 store，滑动实时同步） */
  const fx = useFxSettingsStore(s => s.fx)
  const tuningEnabled = useFxSettingsStore(s => s.tuningEnabled)
  /**
   * 下发给渲染器的实际参数：把「实验调参」里被关掉的项按 0 传下去，
   * 便于逐个隔离定位是哪个参数在影响观感（原值保留在 store，重开即恢复）。
   */
  const fxEffective = useMemo(() => resolveFx(fx, tuningEnabled), [fx, tuningEnabled])
  /** 后端偏好（来自全局 store，用户可在设置面板切换） */
  const backendPreference = useFxSettingsStore(s => s.backendPreference)
  const applyPreset = (index: number) => {
    const next = clampPreset(index)
    setPreset(next)
    storePreset(next)
    window.dispatchEvent(new Event(PRESET_CHANGED_EVENT))
  }

  // 进度条拖拽：拖动中只更新预览，松手才真正 seek（避免拖动过程疯狂 seek）
  const [dragRatio, setDragRatio] = useState<number | null>(null)
  const progressBarRef = useRef<HTMLDivElement>(null)

  const ratioFromClientX = (clientX: number) => {
    const el = progressBarRef.current
    if (!el) return 0
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0) return 0
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
  }

  const onProgressPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return // 仅鼠标左键 / 触摸主指针
    if (!duration || duration <= 0) return
    e.preventDefault()
    setDragRatio(ratioFromClientX(e.clientX))
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }

  const onProgressPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRatio === null) return
    setDragRatio(ratioFromClientX(e.clientX))
  }

  const onProgressPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRatio === null) return
    const ratio = ratioFromClientX(e.clientX)
    if (duration > 0) seek(duration * ratio)
    setDragRatio(null)
    e.currentTarget.releasePointerCapture?.(e.pointerId)
  }

  // 右侧播放列表抽屉
  const queue = usePlayerStore(s => s.queue)
  const currentIndex = usePlayerStore(s => s.currentIndex)
  const playTrack = usePlayerStore(s => s.playTrack)
  const { lines, activeIndex, hasLyric, loading } = useLyrics(track?.uid, currentTime)

  const activeRef = useRef<HTMLDivElement>(null)
  const planeScrollRef = useRef<HTMLDivElement>(null)
  const buffering = bufferProgress !== null

  // 歌词显示模式（持久化：下次打开保持上次选择）
  const [mode, setMode] = useState<LyricsMode>(loadLyricsMode)
  /**
   * 模式可能在「设置 → 歌词显示」里被改（那里写 localStorage 并广播事件），
   * 但本组件才是真正渲染歌词的一方 —— 必须监听并同步，否则切换任何模式都不生效。
   * 同时监听 storage 事件，兼容多标签页 / Tauri 多窗口。
   */
  useEffect(() => {
    const sync = () => setMode(loadLyricsMode())
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'lyrics-display-mode') sync()
    }
    window.addEventListener(LYRICS_MODE_CHANGED_EVENT, sync)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(LYRICS_MODE_CHANGED_EVENT, sync)
      window.removeEventListener('storage', onStorage)
    }
  }, [])
  const cycleMode = () => {
    setMode(m => {
      const next = MODE_ORDER[(MODE_ORDER.indexOf(m) + 1) % MODE_ORDER.length]
      saveLyricsMode(next)
      return next
    })
  }

  // 触屏语义（iOS/iPad/安卓等）：右侧列表改为「小三角点按开合 + 点外部关闭」；
  // 桌面键鼠则用「鼠标移到右缘自动滑出、离开自动收回」。
  // useState 惰性初始化：设备类型一次会话内不变。
  const [isTouch] = useState(() => isMobileLike())
  // 歌词面板内嵌的播放列表抽屉（局部状态，与主界面 QueuePanel 的 isQueueOpen 互不干扰）
  const [queueOpen, setQueueOpen] = useState(false)
  const currentQueueItemRef = useRef<HTMLDivElement>(null)

  // 面板关闭时复位抽屉，避免下次打开残留展开状态
  useEffect(() => {
    if (!isOpen) setQueueOpen(false)
  }, [isOpen])

  // 抽屉展开时滚动到当前播放曲目
  useEffect(() => {
    if (queueOpen) currentQueueItemRef.current?.scrollIntoView({ block: 'center' })
  }, [queueOpen, currentIndex])

  // 单行模式展示的文本：当前句；无歌词/未定位时回退歌名
  const activeLine = lines[activeIndex]

  // WAI-ARIA 对话框模式：Esc 关闭（歌词面板为全屏页，键盘用户需要退出路径）
  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const t = e.target
      if (t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      setLyricsOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, setLyricsOpen])

  // 当前行变化 → 平滑滚动到中央
  useEffect(() => {
    if (activeRef.current) {
      activeRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [activeIndex])

  if (!isOpen || !track) return null

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-background"
      role="dialog"
      aria-modal="true"
      aria-label="歌词面板"
    >
      {/* 动画 keyframes（面板挂载期间有效） */}
      <style>{`
        @keyframes hm-lyric-line-in { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes hm-lyric-sway { from { transform: rotateX(5deg) rotateY(-7deg); } to { transform: rotateX(5deg) rotateY(7deg); } }
      `}</style>      {/* 顶部整条 UI 已按需求下线：
          · 左上角收起箭头 —— 底部的歌曲封面本身就是「点封面返回」，出口未丢；
          · 右上角歌词显示方式 —— 已挪到底部控制条、收藏按钮右侧。
          键盘用户仍可用 Esc 关闭（见上方 keydown 监听）。 */}

      {/* 中部：3D 粒子背景 + 歌词叠加（粒子铺满此区域，WebGPU 优先、自动降级 WebGL2；
          初始化失败时静默退化为纯深色背景，不影响歌词功能）。
          overflow-hidden：右侧列表抽屉收起时平移出界，不能撑出横向滚动 */}
      <div className="relative min-h-0 flex-1 overflow-hidden bg-[#08080C]">
        <ParticleScene
          audio={audio}
          isPlaying={isPlaying}
          preset={preset}
          preference={backendPreference}
          fx={fxEffective}
          coverUrl={
            loadStoredCustomImage() ??
            (track ? buildCoverUrl(track.uid, track.musicInfo.img) : null)
          }
          grid={120}
          fps={60}
          pointSize={0.9}
          className="absolute inset-0"
          onBackend={setBackend}
          onCameraChange={setCameraRot}
        />

        {/* 右上角：仅显示后端状态（WebGPU / WebGL 2.0） */}
        <div className="absolute right-3 top-3 z-10 text-right">
          {backend && (
            <span
              className={`block text-[10px] ${
                backend === 'webgpu' ? 'text-emerald-400/80' : 'text-white/40'
              }`}
              title={
                backend === 'webgpu'
                  ? '正在使用 WebGPU（Compute Shader）'
                  : '已降级到 WebGL 2.0：WebGPU 仅在 HTTPS 或 localhost 下可用'
              }
            >
              {backend === 'webgpu' ? 'WebGPU' : 'WebGL 2.0'}
            </span>
          )}
        </div>

        {/* ── 模式 1：平铺视窗（默认）──
            pointer-events-none：本容器是 absolute inset-0，若不穿透会整块盖住粒子画布，
            吞掉所有指针事件 → 相机旋转/平移/拉伸全部失灵（另一模式那层就漏了这一句）。
            歌词行自身再用 pointer-events-auto 收回点击（点行跳转）能力。 */}
        {mode === 'tile' && (
          <div className="pointer-events-none absolute inset-0 overflow-y-auto px-4 py-8">
            {loading ? (
              <div className="text-center text-white/50">加载歌词...</div>
            ) : hasLyric ? (
              <div className="mx-auto max-w-2xl space-y-5">
                {lines.map((line, i) => {
                  // 纯文本回退行 time 为 NaN：不可点击跳转，样式退化为普通文本
                  const seekable = Number.isFinite(line.time)
                  return (
                    <div
                      key={i}
                      ref={i === activeIndex ? activeRef : undefined}
                      onClick={seekable ? () => seek(line.time) : undefined}
                      className={`pointer-events-auto text-center text-xl transition-all ${
                        seekable ? 'cursor-pointer ' : ''
                      }${
                        i === activeIndex
                          ? 'scale-105 font-bold text-white'
                          : 'text-white/50 hover:text-white/80'
                      }`}
                    >
                      {line.text}
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="text-center text-white/50">暂无歌词</div>
            )}
          </div>
        )}

        {/* ── 模式 2：贴合粒子平面（MineRadio 风）──
            外层 perspective + 内层 rotateX 倾斜形成「平面」，
            当前句 translateZ 凸出、随距离衰减形成前后景深，
            整面随镜头缓慢左右摆动（与粒子静息自转节奏呼应） */}
        {/* 同样需要 pointer-events-none：本容器也是 absolute inset-0，否则切到本模式后相机依旧失灵。
            歌词行用 pointer-events-auto 收回点击跳转。 */}
        {mode === 'plane' && (
          <div className="pointer-events-none absolute inset-0 overflow-y-auto px-4 py-16 [perspective:900px]">
            <div
              className="mx-auto max-w-2xl space-y-6"
              style={{
                transformStyle: 'preserve-3d',
                // 反向旋转相机角度，使歌词平面与粒子封面平行
                // 注意：不使用 hm-lyric-sway 动画，否则 CSS 动画会覆盖 inline transform，
                // 导致歌词无法与专辑封面保持平行
                transform: `rotateX(${-cameraRot.elevationDeg}deg) rotateY(${-cameraRot.yawDeg}deg)`,
              }}
            >
              {loading ? (
                <div className="text-center text-white/50">加载歌词...</div>
              ) : hasLyric ? (
                lines.map((line, i) => {
                  const seekable = Number.isFinite(line.time)
                  const d = Math.abs(i - activeIndex)
                  const z = Math.max(0, 70 - d * 18)
                  return (
                    <div
                      key={i}
                      ref={i === activeIndex ? activeRef : undefined}
                      onClick={seekable ? () => seek(line.time) : undefined}
                      style={{
                        transform: `translateZ(${z}px) scale(${i === activeIndex ? 1.12 : 1})`,
                      }}
                      className={`pointer-events-auto text-center text-xl transition-all duration-300 ${
                        seekable ? 'cursor-pointer ' : ''
                      }${
                        i === activeIndex ? 'font-bold text-white' : 'text-white/40 hover:text-white/75'
                      }`}
                    >
                      {line.text}
                    </div>
                  )
                })
              ) : (
                <div className="text-center text-white/50">暂无歌词</div>
              )}
            </div>
          </div>
        )}

        {/* ── 模式 3：单行悬浮 ──
            按需求改为「压在音量律动条之上」而不是悬在它上方，
            因此实际渲染位置搬到了底部播放条的第一行（见下方 overlay）。 */}

        {/* ── 右侧当前播放列表抽屉 ──
            桌面（键鼠）：鼠标移到右缘自动滑出、离开抽屉区域自动收回（纯 hover，无遮罩，
            不挡歌词点击 seek）；触屏（iOS/iPad/安卓等）：右缘小三角把手点按开合，
            展开时点击列表以外任意处关闭（透明点击层） */}
        <div
          className="absolute inset-y-0 right-0 z-20"
          {...(isTouch
            ? {}
            : {
                onMouseEnter: () => setQueueOpen(true),
                onMouseLeave: () => setQueueOpen(false),
              })}
        >
          {/* 触屏展开时的全屏透明点击层：点列表以外 = 收起（仅触屏渲染，避免挡桌面端歌词点击） */}
          {isTouch && queueOpen && (
            <div className="absolute inset-0" onClick={() => setQueueOpen(false)} aria-hidden="true" />
          )}

          {/* 列表本体：收起时平移出右缘 */}
          <div
            className={`absolute inset-y-0 right-0 flex w-72 max-w-[80vw] flex-col border-l border-border bg-card/95 shadow-2xl backdrop-blur transition-transform duration-300 ${
              queueOpen ? 'translate-x-0' : 'translate-x-full'
            }`}
          >
            <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
              <span className="truncate text-sm font-semibold">当前播放列表（{queue.length}）</span>
              {isTouch && (
                <button
                  onClick={() => setQueueOpen(false)}
                  className="touch-target flex items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
                  aria-label="收起播放列表"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            <div className="flex-1 overflow-y-auto p-2">
              {queue.length === 0 ? (
                <div className="p-8 text-center text-sm text-muted-foreground">队列为空</div>
              ) : (
                queue.map((t, i) => (
                  <div
                    key={`${t.uid}-${i}`}
                    ref={i === currentIndex ? currentQueueItemRef : undefined}
                    className={`flex items-center gap-3 rounded-md p-2 ${
                      i === currentIndex ? 'bg-accent' : 'hover:bg-accent/50'
                    }`}
                  >
                    <button
                      onClick={() => playTrack(t, queue)}
                      className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    >
                      <CoverImage uid={t.uid} cacheKey={t.musicInfo.img} className="h-9 w-9 shrink-0" />
                      <div className="min-w-0">
                        <div className={`truncate text-sm ${i === currentIndex ? 'text-primary' : ''}`}>
                          {t.name}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">{t.artist}</div>
                      </div>
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* 把手：触屏 = 右缘小三角（点按开合，方向随开合态翻转）；桌面 = 透明 hover 热区 */}
          {isTouch ? (
            <button
              onClick={() => setQueueOpen(o => !o)}
              className="absolute right-0 top-1/2 flex h-14 w-7 -translate-y-1/2 items-center justify-center rounded-l-md border border-r-0 border-border bg-card/90 text-muted-foreground backdrop-blur"
              aria-label={queueOpen ? '收起播放列表' : '展开播放列表'}
            >
              <span
                className={`block h-0 w-0 border-y-[7px] border-y-transparent transition-transform ${
                  queueOpen ? 'border-l-[9px] border-l-current' : 'border-r-[9px] border-r-current'
                }`}
              />
            </button>
          ) : (
            <div className="absolute inset-y-0 right-0 w-8" aria-hidden="true" />
          )}
        </div>
      </div>

      {/* 底部：迷你播放条（封面+歌名/歌手+控制+关闭），safe-area-bottom 避开手势条 */}
      <div className="safe-area-bottom shrink-0 border-t border-border bg-card px-3 py-2">
        {/* 歌曲信息 */}
        <div className="relative mb-2 flex min-w-0 items-center gap-3">
          {/* 底部封面可点击 = 收起歌词面板（与顶部收起箭头等效，拇指易触达） */}
          <button
            onClick={() => setLyricsOpen(false)}
            className="shrink-0 rounded-full transition hover:opacity-80 active:scale-95"
            aria-label="收起歌词"
            title="收起歌词"
          >
            <CoverImage uid={track.uid} cacheKey={track.musicInfo.img} className="h-10 w-10" />
          </button>
          <div className="min-w-0 w-32 shrink-0 sm:w-52 md:w-64">
            <div className="truncate text-sm font-medium">{track.name}</div>
            <div className="truncate text-xs text-muted-foreground">{track.artist}</div>
          </div>
          {/* 宽屏时以视口中央对齐；窄屏退回弹性布局，确保不裁切。 */}
          <AudioSpectrum
            audio={audio}
            isPlaying={isPlaying}
            className="h-7 min-w-0 flex-1 xl:absolute xl:left-1/2 xl:w-[min(48vw,52rem)] xl:-translate-x-1/2"
          />
          {/* 单行歌词：按需求压在音量律动条之上（而非悬在它上方）。
             绝对定位覆盖整行中央，z-10 保证在频谱之上；强投影保证压着频谱也读得清。
              左右留内边距，让文字集中在频谱所在的中央区域，不与封面/歌手名抢位。 */}
          {mode === 'single' && (
            <div className="pointer-events-none absolute inset-x-0 top-1/2 z-10 -translate-y-1/2 px-14 text-center sm:px-24">
              <div
                key={activeIndex}
                style={{ animation: 'hm-lyric-line-in .35s ease-out both' }}
                className="truncate text-lg font-bold text-white [text-shadow:0_2px_10px_rgba(0,0,0,0.85)] sm:text-xl"
              >
                {activeLine ? activeLine.text : track.name}
              </div>
            </div>
          )}
        </div>
        {/* 进度条（细线）+ 时间 */}
        <div className="mb-2 flex items-center gap-2 text-[10px] tabular-nums text-muted-foreground">
          <span className="w-9 text-right">
            {buffering
              ? `${bufferProgress}%`
              : formatTimeShort(dragRatio !== null ? duration * dragRatio : currentTime)}
          </span>
          <div
              ref={progressBarRef}
              onPointerDown={onProgressPointerDown}
              onPointerMove={onProgressPointerMove}
              onPointerUp={onProgressPointerUp}
              onPointerCancel={onProgressPointerUp}
              role="slider"
              aria-label="播放进度"
              aria-valuemin={0}
              aria-valuemax={Math.max(0, Math.round(duration))}
              aria-valuenow={Math.round(dragRatio !== null ? duration * dragRatio : currentTime)}
              className="relative h-1 flex-1 cursor-pointer touch-none overflow-visible rounded-full bg-muted after:absolute after:inset-x-0 after:-top-2 after:-bottom-2 after:content-['']"
            >
            <div
              className={`absolute inset-y-0 left-0 rounded-full bg-primary ${
                dragRatio === null ? "transition-[width] duration-200" : ""
              }`}
              style={{
                width: `${
                  dragRatio !== null
                    ? dragRatio * 100
                    : buffering
                      ? bufferProgress
                      : duration > 0
                        ? (currentTime / duration) * 100
                        : 0
                }%`,
              }}
            />
            {/* 白色小圆点：跟随播放位置，hover/拖拽时显示 */}
            <div
              className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow"
              style={{
                left: `${
                  dragRatio !== null
                    ? dragRatio * 100
                    : buffering
                      ? bufferProgress ?? 0
                      : duration > 0
                        ? (currentTime / duration) * 100
                        : 0
                }%`,
                opacity: dragRatio !== null ? 1 : 0,
                transition: dragRatio === null ? 'opacity 0.2s' : 'none',
              }}
            />
          </div>
          <span className="w-9">
            {buffering ? '加载' : formatTimeShort(duration)}
          </span>
        </div>
        {/* 控制按钮：循环模式 / 上一首 / 播放 / 下一首 / 收藏 —— 全部居中收拢成一组。
            原先用 justify-between 会把循环与收藏顶到屏幕两侧，操作时手指要来回跨屏；
            改成居中 + 与中键组一致的 6 号间距，五个按钮形成均匀的一簇。 */}
        <div className="flex items-center justify-center gap-6">
          {/* 下载当前歌曲：保存到 NAS 服务端的 /app/prisma/prisma/data/music */}
          <button
            onClick={() =>
              download({
                uid: track.uid,
                quality: pickHighestQuality(
                  (track.musicInfo as { types?: unknown } | undefined)?.types
                ),
              })
            }
            disabled={downloading}
            className="touch-target flex items-center justify-center rounded-full text-muted-foreground transition hover:text-foreground disabled:opacity-60"
            aria-label={downloading ? '下载中' : '下载歌曲'}
            title={downloading ? '下载中…' : '下载歌曲'}
          >
            <Download className="h-5 w-5" />
          </button>

          <button
            onClick={cyclePlaybackMode}
            className={`touch-target flex items-center justify-center rounded-full transition hover:text-foreground ${
              playbackMode !== 'sequence' ? 'text-primary' : 'text-muted-foreground'
            }`}
            aria-label={
              playbackMode === 'loop'
                ? '单曲循环（点击切换播放模式）'
                : playbackMode === 'random'
                  ? '随机播放（点击切换播放模式）'
                  : '顺序播放（点击切换播放模式）'
            }
            title={
              playbackMode === 'loop'
                ? '单曲循环（点击切换播放模式）'
                : playbackMode === 'random'
                  ? '随机播放（点击切换播放模式）'
                  : '顺序播放（点击切换播放模式）'
            }
          >
            {playbackMode === 'loop' ? (
              <Repeat1 className="h-5 w-5" />
            ) : playbackMode === 'random' ? (
              <Shuffle className="h-5 w-5" />
            ) : (
              <Repeat className="h-5 w-5" />
            )}
          </button>
          <div className="flex items-center gap-6">
            <button
              onClick={previous}
              className="touch-target flex items-center justify-center rounded-full text-muted-foreground transition hover:text-foreground"
              aria-label="上一首"
            >
              <SkipBack className="h-5 w-5 fill-current" />
            </button>
            <button
              onClick={togglePlay}
              disabled={buffering}
              className="touch-target flex items-center justify-center rounded-full bg-foreground text-background transition hover:scale-105 disabled:opacity-60 disabled:hover:scale-100"
              aria-label="播放/暂停"
            >
              {buffering ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : isPlaying ? (
                <Pause className="h-5 w-5 fill-current" />
              ) : (
                <Play className="h-5 w-5 fill-current" />
              )}
            </button>
            <button
              onClick={next}
              className="touch-target flex items-center justify-center rounded-full text-muted-foreground transition hover:text-foreground"
              aria-label="下一首"
            >
              <SkipForward className="h-5 w-5 fill-current" />
            </button>
          </div>
          <button
            onClick={() => toggleFavorite(track.uid).catch(() => {})}
            className={`touch-target flex items-center justify-center rounded-full transition hover:text-foreground ${
              isFav ? 'text-primary' : 'text-muted-foreground'
            }`}
            aria-label={isFav ? '取消收藏' : '收藏'}
            title={isFav ? '取消收藏' : '收藏'}
          >
            <Heart className={`h-5 w-5 ${isFav ? 'fill-current' : ''}`} />
          </button>
          {/* 歌词显示方式（平铺 → 贴合粒子 → 单行）：按需求从顶栏挪到收藏按钮右侧 */}
          <button
            onClick={() => setSettingsOpen(true)}
            className="touch-target flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground"
            title="设置（含视觉预设、动效参数与歌词显示模式）"
            aria-label="打开设置面板"
          >
            <Settings className="h-4 w-4" />
            <span>设置</span>
          </button>
          {/* debug：实验调参面板入口（独立面板，默认不打扰普通用户） */}
          <button
            onClick={() => setTuningOpen(true)}
            className="touch-target flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground"
            title="实验调参（debug）：实时调节粒子物理/尺寸/亮度参数"
            aria-label="打开实验调参面板"
          >
            <FlaskConical className="h-4 w-4" />
            <span>调参</span>
          </button>
        </div>
      </div>

      {/* 粒子设置抽屉（含视觉预设 + 动效参数标签页，覆盖在 dialog 之上） */}
      <ParticleSettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      {/* 实验调参抽屉（debug，仅由「调参」按钮打开） */}
      <ParticleTuningPanel open={tuningOpen} onClose={() => setTuningOpen(false)} />
    </div>
  )
}

/** 紧凑时间格式：mm:ss */
function formatTimeShort(t: number): string {
  if (!Number.isFinite(t) || t <= 0) return '0:00'
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}
