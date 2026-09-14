/**
 * ParticleScene —— 粒子可视化 React 组件（后端无关）。
 *
 * 职责划分：
 *   · 本组件：音频分析、节拍追踪、形态缓动、封面加载、镜头控制（Maya / 多指手势）、
 *     渲染循环、生命周期
 *   · 渲染后端：由 lib/client/particle 的工厂按 WebGPU → WebGL 2.0 顺序创建
 *
 * 两条后端共用同一份音频特征、涟漪数据与镜头状态，因此交互与观感完全一致。
 *
 * # 粒子形态
 * 每个粒子有两个归宿形态，由 `coverMix` 平滑插值：
 *   · 封面形态：粒子铺成一块平面、按 UV 采样专辑封面 → 拼出可辨认的专辑图，
 *     Z 轴由音频驱动呼吸/浮雕，节拍时径向爆散再平滑回落；
 *   · 星云形态：球面随机分布 + 噪声流场漂移。
 * 没有封面（或 `morphMode='nebula'`）时自动停留在星云形态；切歌载入新封面时
 * `coverMix` 先归零再升到 1，于是每次都有一段「散开 → 重新聚成新封面」的过渡。
 *
 * 音频数据源复用项目既有分析管线（lib/client/audio-analysis）：
 * createMediaElementSource 对同一元素只能调用一次，且 iOS 必须整体禁用接管
 * （详见该模块注释），因此这里绝不自建 AudioContext：
 *   · 手势内 → attachAnalysisPipeline()
 *   · 非手势 → getExistingAnalysisPipeline()
 *   · 拿不到 → spectrumSynth() 合成频谱兜底（iOS / 接管失败）
 *
 * 许可证：本文件为独立实现，仅参考 Mineradio 的视觉架构
 * （点阵粒子采样封面 + 音频 uniform 驱动），未复制其 GPL-3.0 源码，不引入 copyleft 传染。
 */

import { useEffect, useRef, useState } from 'react'
import {
  attachAnalysisPipeline,
  getExistingAnalysisPipeline,
  type AudioAnalysisPipeline,
} from '@/lib/client/audio-analysis'
import { spectrumSynth, SPECTRUM_SYNTH_BINS } from '@/lib/client/spectrum-synth'
import {
  createParticleRenderer,
  ParticleBackendUnavailableError,
  type BackendPreference,
} from '@/lib/client/particle'
import type { BackendKind, ParticleRenderer } from '@/lib/client/particle/types'
import { DEFAULT_FX, type FxSettings } from '@/lib/client/particle/types'
import { createBeatTracker, type BandFeature } from '@/lib/client/particle/beat'
import { loadCoverTexture, type CoverTexture } from '@/lib/client/particle/cover-texture'
import { enhanceCoverDepth } from '@/lib/client/particle/cover-depth-ai'
import { loadSkullPointCloud, resampleSkull } from '@/lib/client/particle/skull-points'
import { isMobileLike, suggestedGrid } from '@/lib/utils/device'
import { subscribePresetChange, loadStoredPreset } from '@/lib/client/particle/presets'

export interface ParticleSceneProps {
  /** 当前播放的原生音频元素；为 null 时粒子仅做静息动画。 */
  audio?: HTMLAudioElement | null
  isPlaying?: boolean
  /** 远程模式：外部（如 Tauri IPC）注入的频谱，优先于本地分析。 */
  remoteSpectrum?: Uint8Array | null
  /** 当前曲目的封面 URL（buildCoverUrl 生成）；为 null 时停留在星云形态。 */
  coverUrl?: string | null
  /**
   * 粒子视觉预设索引（0..12，见 lib/client/particle/presets.ts）。
   * 默认 0 = 专辑封面；该预设下若拿不到封面会自动退化为星云形态。
   */
  preset?: number
  /** 粒子网格基准边长（粒子数 = grid×grid）；移动端自动降级。 */
  grid?: number
  /** 帧率上限。 */
  fps?: number
  /** 粒子尺寸倍率（由菜单滑块调节）。 */
  pointSize?: number
  /** 暂停渲染（页面不可见 / 全屏遮挡 / 手动关闭）。 */
  paused?: boolean
  /** 后端偏好：auto / webgpu / webgl2 */
  preference?: BackendPreference
  /** 动效参数（强度/速度/景深/扭曲/离散/光晕/边缘/背景压暗）；来自 FxSettingsStore */
  fx?: FxSettings
  /** 滚轮回调：滚轮不控制镜头，转交外层菜单滑块。 */
  onWheelMenu?: (deltaY: number) => void
  /** 后端就绪回调（供 UI 显示当前渲染后端）。 */
  onBackend?: (backend: BackendKind) => void
  /** 初始化失败回调（如环境不支持 WebGPU/WebGL2）。 */
  onError?: (message: string) => void
  className?: string
}

type DragMode = 'none' | 'rotate' | 'pan' | 'dolly'

/** 形态缓动速率（1/秒）：约 1.3s 完成 90%，留足「散开 → 重聚」的观感时间。 */
const MORPH_RATE = 1.8

/** 预设切换爆散的回落速率（1/秒）：约 0.6s 衰减到 1/10，够粒子飞出去再平滑落位。 */
const PRESET_BURST_DECAY = 3.6

/** 星河背景层粒子数（PC / 移动端）。移动端减半，避免背景层拖累低端 GPU。 */
const STAR_COUNT_PC = 1400
const STAR_COUNT_MOBILE = 700

/**
 * 把 Mineradio 的 φ 换算成本项目的 φ。
 *
 * 两边对 φ 的定义是**互余**的，直接照抄会把相机放到错误的位置：
 *   · Mineradio：`y = r·sinφ`、XZ 半径 `= r·cosφ` → φ 是「自 XZ 平面抬起的仰角」；
 *   · 本项目：  `y = r·cosφ`、XZ 半径 `= r·sinφ` → φ 是「自 +Y 轴量起的极角」。
 * 因此 `本项目 φ = π/2 − Mineradio φ`。θ 的定义两边一致（自 +Z 轴转向 +X），无需换算。
 */
const toPolarPhi = (elevation: number) => Math.PI / 2 - elevation

/**
 * 相机基线：逐项对齐 Mineradio 的 `defaultOrbitStateForPreset`。
 * φ≈0.08（仰角）即几乎正对 XY 平面 —— 封面、唱片这类平面预设必须正对才有意义。
 * 索引与 lib/client/particle/presets.ts 的预设表一一对应。
 */
const PRESET_CAMERA: ReadonlyArray<{ theta: number; phi: number; radius: number }> = [
  { theta: 0.0, phi: toPolarPhi(0.08), radius: 6.6 }, // 0 专辑封面
  { theta: 0.0, phi: toPolarPhi(0.03), radius: 6.2 }, // 1 滚筒
  { theta: 0.0, phi: toPolarPhi(0.15), radius: 7.0 }, // 2 星球
  { theta: 0.0, phi: toPolarPhi(0.05), radius: 8.0 }, // 3 虚空
  { theta: 0.0, phi: toPolarPhi(0.04), radius: 6.5 }, // 4 唱片
  { theta: 0.0, phi: toPolarPhi(0.08), radius: 6.6 }, // 5 音域回响
  { theta: 0.18, phi: toPolarPhi(0.1), radius: 7.4 }, // 6 骷髅点云
  { theta: 0.0, phi: toPolarPhi(0.08), radius: 6.6 }, // 7 音域回响
  { theta: 0.0, phi: toPolarPhi(0.08), radius: 6.6 }, // 8 音域回响
  { theta: -0.08, phi: toPolarPhi(0.12), radius: 7.4 }, // 9 月蚀圣杯
  { theta: 0.0, phi: toPolarPhi(0.02), radius: 7.15 }, // 10 雨幕霓虹
  { theta: 0.1, phi: toPolarPhi(0.11), radius: 7.0 }, // 11 折光蝶群
  { theta: -0.12, phi: toPolarPhi(0.18), radius: 7.35 }, // 12 深海绽放
]

/** Mineradio 对「切到预设 5」保持当前镜头；其余预设切过去会重置到基线。 */
/** 骷髅点云预设（对应外部点云资源）。 */
const SKULL_PRESET = 6

const PRESET_KEEP_CAMERA = 5

/** 相机限制：对齐 Mineradio 的 minPhi/maxPhi/minRadius/maxRadius（同样要换算 φ）。
 *  RADIUS_MAX 放大 100×：允许用户用 Alt+右键/滚轮大幅拉远镜头，避免在较大粒子上"顶死"。 */
const PHI_ELEVATION_LIMIT = Math.PI * 0.45
const PHI_MIN = Math.PI / 2 - PHI_ELEVATION_LIMIT
const PHI_MAX = Math.PI / 2 + PHI_ELEVATION_LIMIT
const RADIUS_MIN = 2.4
const RADIUS_MAX = 14.0 * 100  // 1400

export function ParticleScene({
  audio = null,
  isPlaying = false,
  remoteSpectrum = null,
  coverUrl = null,
  preset = 0,
  grid = 160,
  fps = 60,
  pointSize = 1,
  paused = false,
  preference = 'auto',
  fx = DEFAULT_FX,
  onWheelMenu,
  onBackend,
  onError,
  className = '',
}: ParticleSceneProps) {
  const mountRef = useRef<HTMLDivElement>(null)
  const [backend, setBackend] = useState<BackendKind | null>(null)

  /** 渲染器实例：主 effect 创建，封面 effect 复用（封面切换不重建整个场景）。 */
  const rendererRef = useRef<ParticleRenderer | null>(null)
  /** 封面 effect 早于渲染器就绪时，把结果暂存到这里，由主 effect 初始化后补上。 */
  const pendingCoverRef = useRef<CoverTexture | null>(null)
  /** 频段 bin 边界（按真实采样率/fftSize 对齐 Mineradio 的频率分区），bindPipeline 时填充。 */
  const bandBinsRef = useRef({ bassLo: 2, bassHi: 20, midLo: 121, midHi: 288, trebLo: 288, trebHi: 1023 })

  /** 当前是否已装载真实封面（决定 auto 形态的目标值）。 */
  const hasCoverRef = useRef(false)
  /** 封面代次：每装载一张新封面 +1，渲染循环据此把 coverMix 归零重聚。 */
  const coverEpochRef = useRef(0)
  /** 诊断用：上一次打印过的预设（预设变化时只打一次，避免刷屏）。 */
  const lastLoggedPresetRef = useRef<number | undefined>(undefined)
  /** 诊断用：封面已成形只打一次；散开后复位，便于再次观察。 */
  const coverFormedLoggedRef = useRef(false)
  /** 诊断用：封面状态摘要的节流时间戳（ms），每 2 秒打一次。 */
  const lastCoverSummaryAtRef = useRef(0)
  /** 骷髅点云是否已加载过（避免重复 fetch）。 */
  const skullLoadedRef = useRef(false)
  /** 当前动效参数：每次 `fx` prop 变化都更新这里，渲染循环读取它。 */
  const fxRef = useRef<FxSettings>(fx)
  fxRef.current = fx

  /** 供事件回调与渲染循环读取的最新值，避免重建场景。 */
  // preset 不进每次渲染的重建对象：预设切换经 storePreset + PRESET_CHANGED_EVENT
  // 由下方 effect 写入；props.preset 来自 LyricsPanel 旧 state，若在此覆盖会令
  // 「切了预设又被重渲染弹回专辑封面」——这正是预设切了不生效的根因。
  const liveRef = useRef({ isPlaying, paused, remoteSpectrum, onWheelMenu, fps, preset: loadStoredPreset() })
  // 每次渲染重建时保留 preset 当前值（由 storePreset + PRESET_CHANGED_EVENT effect 写入），
  // 不从 props.preset 覆盖，否则「切了预设又被重渲染弹回专辑封面」。
  // 注意：useRef 无显式类型参数，会从上面初始化对象推断出 liveRef.current 含必填 preset，
  // 故此处必须带上 preset，否则 TS2741。
  liveRef.current = { isPlaying, paused, remoteSpectrum, onWheelMenu, fps, preset: liveRef.current.preset }

  /**
    * 监听 FxSettings 变化 → 实时下发给渲染器。
    * 独立 effect：只在 renderer 就绪（rendererRef.current 变化）且 fx 变化时触发，
    * 避免在场景初始化前空跑。
    */
   useEffect(() => {
     if (!rendererRef.current) return
     rendererRef.current.setFx(fx)
   }, [fx])

  // 监听预设变化（设置面板 / 歌词面板 / 跨窗口 localStorage 同步）：
  // 外部切换预设时把最新值写入 liveRef，供渲染循环实时采用，无需重建场景。
  useEffect(() => {
    return subscribePresetChange((preset) => {
      liveRef.current.preset = preset
    })
  }, [])

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    let disposed = false
    let renderer: ParticleRenderer | null = null
    let raf: number | null = null
    let resizeTimer: ReturnType<typeof setTimeout> | null = null

    const isMobile = isMobileLike()
    const count = suggestedGrid(grid) * suggestedGrid(grid)

    // ---------- 镜头 rig（Maya 风格球坐标 + 平移目标） ----------
    // 初始机位取当前预设的基线（对齐 Mineradio 的 applyPresetOrbitBaseline）
    const initialCamera =
      PRESET_CAMERA[Math.max(0, Math.min(PRESET_CAMERA.length - 1, Math.round(preset)))]
    const rig = {
      radius: initialCamera.radius,
      theta: initialCamera.theta,
      phi: initialCamera.phi,
      target: [0, 0, 0] as [number, number, number],
    }

    const rotateBy = (dx: number, dy: number) => {
      rig.theta -= dx * 0.0055
      rig.phi = Math.min(PHI_MAX, Math.max(PHI_MIN, rig.phi - dy * 0.0055))
    }
    const dollyBy = (dy: number) => {
      rig.radius = Math.min(RADIUS_MAX, Math.max(RADIUS_MIN, rig.radius * (1 + dy * 0.0022)))
    }
    /** 平移：用当前相机基向量，保证远近视觉速度一致。 */
    const panBy = (dx: number, dy: number, basis: (() => number[][]) | null) => {
      const k = rig.radius * 0.0016
      if (basis) {
        const [right, up] = basis()
        for (let i = 0; i < 3; i++) {
          rig.target[i] += (-right[i] * dx + up[i] * dy) * k
        }
      }
    }
    /** 由 rig 推导相机基向量（右 / 上），供平移使用。 */
    const cameraBasis = () => {
      const sp = Math.sin(rig.phi)
      const px = rig.target[0] + rig.radius * sp * Math.sin(rig.theta)
      const py = rig.target[1] + rig.radius * Math.cos(rig.phi)
      const pz = rig.target[2] + rig.radius * sp * Math.cos(rig.theta)
      // forward = normalize(target - pos)
      let fx = rig.target[0] - px
      let fy = rig.target[1] - py
      let fz = rig.target[2] - pz
      const fl = Math.hypot(fx, fy, fz) || 1
      fx /= fl
      fy /= fl
      fz /= fl
      // right = normalize(cross(forward, worldUp)) = normalize((fz, 0, -fx))
      let rx = fz
      let ry = 0
      let rz = -fx
      const rl = Math.hypot(rx, ry, rz) || 1
      rx /= rl
      ry /= rl
      rz /= rl
      // up = cross(right, forward)
      const ux = ry * fz - rz * fy
      const uy = rz * fx - rx * fz
      const uz = rx * fy - ry * fx
      return [
        [rx, ry, rz],
        [ux, uy, uz],
      ]
    }

    // ---------- 交互状态 ----------
    let mode: DragMode = 'none'
    let lastX = 0
    let lastY = 0
    let touchMode: DragMode = 'none'

    // ---------- 音频分析 ----------
    let pipeline: AudioAnalysisPipeline | null = null
    let freqData: Uint8Array<ArrayBuffer> | null = null
    const synthTarget = new Uint8Array(SPECTRUM_SYNTH_BINS)
    const synthSmooth = new Uint8Array(SPECTRUM_SYNTH_BINS)
    let usingSynth = true

    const bindPipeline = (p: AudioAnalysisPipeline | null) => {
      if (!p) return false
      pipeline = p
      const n = p.analyser.frequencyBinCount
      freqData = new Uint8Array(n)
      // 频段 bin 边界：按真实采样率/fftSize 映射 Mineradio 的频率分区
      // （bass 40-420Hz / mid 2600-6200Hz / treble 6200Hz+，对齐 11-main-loop.js:368-390）
      const sr = p.context.sampleRate || 44100
      const fft = p.analyser.fftSize || n * 2
      const hzPerBin = sr / fft
      const binOf = (hz: number) => Math.max(0, Math.min(n - 1, Math.round(hz / hzPerBin)))
      bandBinsRef.current = {
        bassLo: binOf(40),
        bassHi: binOf(420),
        midLo: binOf(2600),
        midHi: binOf(6200),
        trebLo: binOf(6200),
        trebHi: n - 1,
      }
      usingSynth = false
      return true
    }
    const onGesture = () => {
      if (!audio || pipeline) return
      void attachAnalysisPipeline(audio).then(p => bindPipeline(p))
    }
    const onAudioPlay = () => {
      if (!audio || pipeline) return
      bindPipeline(getExistingAnalysisPipeline(audio))
    }

    if (audio) {
      audio.addEventListener('play', onAudioPlay)
      audio.addEventListener('playing', onAudioPlay)
      bindPipeline(getExistingAnalysisPipeline(audio))
      window.addEventListener('pointerdown', onGesture, { capture: true, passive: true })
      window.addEventListener('touchstart', onGesture, { capture: true, passive: true })
      window.addEventListener('click', onGesture, { capture: true, passive: true })
    }

    /**
     * 提取原始频段能量（0..1，未平滑）。
     * 平滑、onset 检测、脉冲包络与涟漪全部交给 beat tracker —— 那里是 dt 归一化的，
     * 而按帧平滑会让不同帧率下的律动强度产生差异（上一版的实际缺陷）。
     */
    const readBands = (now: number, dt: number): BandFeature => {
      const remote = liveRef.current.remoteSpectrum
      let data: Uint8Array
      if (remote && remote.length > 0) {
        data = remote
      } else if (pipeline && freqData && !usingSynth) {
        pipeline.analyser.getByteFrequencyData(freqData)
        data = freqData
      } else {
        spectrumSynth(synthTarget, now)
        // 合成频谱自身带抖动，按 dt 归一化平滑一下，避免兜底路径看起来发毛
        const k = 1 - Math.exp(-dt / 0.06)
        for (let i = 0; i < synthSmooth.length; i++) {
          synthSmooth[i] += Math.round((synthTarget[i] - synthSmooth[i]) * k)
        }
        data = synthSmooth
      }

      const bins = bandBinsRef.current
      const n = data.length
      // 按频率范围取 RMS（对齐 Mineradio 的 beatBandRms：bass 40-420Hz / mid 2600-6200Hz / treble 6200Hz+），
      // 用 RMS 而非算术平均，更接近频段真实能量，也避免把大量非 kick 能量算进低频。
      const bandRms = (lo: number, hi: number): number => {
        const a = Math.max(0, Math.min(n - 1, lo))
        const b = Math.max(0, Math.min(n - 1, hi))
        if (b < a) return 0
        let s = 0
        for (let i = a; i <= b; i++) s += data[i] * data[i]
        return Math.sqrt(s / (b - a + 1)) / 255
      }
      const rb = bandRms(bins.bassLo, bins.bassHi)
      const rm = bandRms(bins.midLo, bins.midHi)
      const rt = bandRms(bins.trebLo, bins.trebHi)
      const re = bandRms(0, n - 1)

      // 既无分析管线又未在播放时，让粒子完全静息（否则合成频谱会自嗨）
      const active = liveRef.current.isPlaying || !usingSynth ? 1 : 0
      return {
        bass: rb * active,
        mid: rm * active,
        treble: rt * active,
        energy: re * active,
      }
    }

    const tracker = createBeatTracker()

    // ---------- 事件绑定（renderer 就绪后需要 canvas） ----------
    let canvas: HTMLElement | null = null
    const detachEvents = () => {
      if (!canvas) return
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerUp)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('contextmenu', onContextMenu)
      canvas.removeEventListener('touchstart', onTouchStart)
      canvas.removeEventListener('touchmove', onTouchMove)
      canvas.removeEventListener('touchend', onTouchEnd)
      canvas.removeEventListener('touchcancel', onTouchEnd)
    }

    const onPointerDown = (e: Event) => {
      const pe = e as PointerEvent
      if (pe.pointerType !== 'mouse') return
      if (pe.button === 1 && pe.altKey) mode = 'rotate'
      else if (pe.button === 2 && pe.altKey) mode = 'dolly'
      else if (pe.button === 1) mode = 'pan'
      else return
      lastX = pe.clientX
      lastY = pe.clientY
      ;(canvas as HTMLCanvasElement)?.setPointerCapture?.(pe.pointerId)
      pe.preventDefault()
    }
    const onPointerMove = (e: Event) => {
      if (mode === 'none') return
      const pe = e as PointerEvent
      const dx = pe.clientX - lastX
      const dy = pe.clientY - lastY
      lastX = pe.clientX
      lastY = pe.clientY
      if (mode === 'rotate') rotateBy(dx, dy)
      else if (mode === 'dolly') dollyBy(dy)
      else if (mode === 'pan') panBy(dx, dy, cameraBasis)
    }
    const onPointerUp = (e: Event) => {
      if (mode === 'none') return
      mode = 'none'
      const pe = e as PointerEvent
      ;(canvas as HTMLCanvasElement)?.releasePointerCapture?.(pe.pointerId)
    }
    /** 滚轮不控制镜头，转交外层菜单滑块。 */
    const onWheel = (e: Event) => {
      e.preventDefault()
      liveRef.current.onWheelMenu?.((e as WheelEvent).deltaY)
    }
    const onContextMenu = (e: Event) => e.preventDefault()

    const centroid = (t: TouchList) => {
      let x = 0
      let y = 0
      for (let i = 0; i < t.length; i++) {
        x += t[i].clientX
        y += t[i].clientY
      }
      return { x: x / t.length, y: y / t.length }
    }
    const onTouchStart = (e: Event) => {
      const te = e as TouchEvent
      const n = te.touches.length
      touchMode = n === 1 ? 'rotate' : n === 2 ? 'pan' : n >= 3 ? 'dolly' : 'none'
      if (touchMode === 'none') return
      const c = centroid(te.touches)
      lastX = c.x
      lastY = c.y
      if (te.cancelable) te.preventDefault()
    }
    const onTouchMove = (e: Event) => {
      if (touchMode === 'none') return
      const te = e as TouchEvent
      const c = centroid(te.touches)
      const dx = c.x - lastX
      const dy = c.y - lastY
      lastX = c.x
      lastY = c.y
      if (touchMode === 'rotate') rotateBy(dx, dy)
      else if (touchMode === 'pan') panBy(dx, dy, cameraBasis)
      else if (touchMode === 'dolly') dollyBy(dy)
      if (te.cancelable) te.preventDefault()
    }
    const onTouchEnd = () => {
      touchMode = 'none'
    }

    // ---------- 初始化 ----------
    void createParticleRenderer(
      {
        container: mount,
        count,
        pointSize,
        starCount: isMobile ? STAR_COUNT_MOBILE : STAR_COUNT_PC,
      },
      preference,
      resolved => {
        setBackend(resolved)
        onBackend?.(resolved)
      },
    )
      .then(r => {
        if (disposed) {
          r.dispose()
          return
        }
        renderer = r
        rendererRef.current = r
        // 补下发初始预设：后端默认是 0，若用户记住的是别的预设，
        // 只靠渲染循环里的「变化检测」会永远不生效（值从未变过）
        r.setPreset(liveRef.current.preset)
        // 封面 effect 可能先于渲染器完成，这里补上暂存结果
        if (pendingCoverRef.current) {
          r.setCover(pendingCoverRef.current)
          hasCoverRef.current = true
        }
        canvas = mount.querySelector('canvas')
        if (canvas) {
          if (!isMobile) {
            canvas.addEventListener('pointerdown', onPointerDown)
            canvas.addEventListener('pointermove', onPointerMove)
            canvas.addEventListener('pointerup', onPointerUp)
            canvas.addEventListener('pointercancel', onPointerUp)
            canvas.addEventListener('wheel', onWheel, { passive: false })
            canvas.addEventListener('contextmenu', onContextMenu)
          } else {
            canvas.addEventListener('touchstart', onTouchStart, { passive: false })
            canvas.addEventListener('touchmove', onTouchMove, { passive: false })
            canvas.addEventListener('touchend', onTouchEnd)
            canvas.addEventListener('touchcancel', onTouchEnd)
          }
        }

        const resize = () => {
          renderer?.resize(mount.clientWidth || 1, mount.clientHeight || 1)
        }
        resize()

        let lastFrame = 0
        let lastRenderedAt = performance.now()
        const start = performance.now()

        // 缓动状态（每次重建场景重置；切歌时由 coverEpoch 触发归零重聚）
        let coverMix = 0
        let seenEpoch = coverEpochRef.current
        // 预设切换爆散：切换那一帧拉满，之后按 dt 指数回落
        let presetBurst = 0
        // 记录已下发给后端的预设，避免每帧重复调用 setPreset
        let appliedPreset = liveRef.current.preset

        const loop = (now: number) => {
          raf = requestAnimationFrame(loop)
          const interval = 1000 / Math.max(1, liveRef.current.fps)
          if (now - lastFrame < interval - 1) return
          lastFrame = now
          if (liveRef.current.paused || document.hidden) return

          // 与上一「实际渲染帧」的间隔：帧率上限与暂停都被自然计入，无需额外补偿
          const dt = Math.min(0.05, Math.max(1 / 240, (now - lastRenderedAt) / 1000))
          lastRenderedAt = now

          const frame = tracker.update(dt, readBands(now, dt))

          // ---- 预设切换：先爆散再落位（不是瞬移） ----
          const nextPreset = liveRef.current.preset
          if (nextPreset !== appliedPreset) {
            appliedPreset = nextPreset
            renderer?.setPreset(nextPreset)
            presetBurst = 1
            // 切预设时重置到该预设的机位基线（对齐 Mineradio 的 applyPresetOrbitBaseline）；
            // 唯独预设 5 保持当前镜头，避免把用户手动调好的视角拉回去
            // 预设 6（骷髅点云）：首次切到时异步加载外部点云并抽稀下发
          if (nextPreset === SKULL_PRESET && !skullLoadedRef.current) {
            skullLoadedRef.current = true
            void loadSkullPointCloud().then(cloud => {
              if (!cloud) return
              const g = Math.max(1, Math.round(Math.sqrt(count)))
              const sampled = resampleSkull(cloud, g * g)
              if (sampled) rendererRef.current?.setSkullPoints(sampled.positions)
            })
          }

          if (nextPreset !== PRESET_KEEP_CAMERA) {
              const base =
                PRESET_CAMERA[Math.max(0, Math.min(PRESET_CAMERA.length - 1, nextPreset))]
              rig.radius = base.radius
              rig.theta = base.theta
              rig.phi = base.phi
              rig.target[0] = 0
              rig.target[1] = 0
              rig.target[2] = 0
            }
          }
          // 爆散强度按 dt 指数回落（与帧率解耦，120FPS 与 30FPS 观感一致）
          presetBurst *= Math.exp(-dt * PRESET_BURST_DECAY)
          renderer?.setPresetBurst(presetBurst)

          // ---- 封面形态缓动：只有预设 0（专辑封面）使用，目标 0=星云 / 1=封面 ----
          if (coverEpochRef.current !== seenEpoch) {
            seenEpoch = coverEpochRef.current
            coverMix = 0 // 新封面：先散开成星云，再重新聚拢成新的专辑图
            console.warn('[particle] 封面代次变化 epoch=', seenEpoch, '→ coverMix 归零重聚')
          }
          const target = nextPreset < 0.5 && hasCoverRef.current ? 1 : 0
          coverMix += (target - coverMix) * (1 - Math.exp(-dt * MORPH_RATE))
          // smoothstep 缓动：起步与收尾都平缓，中途快，避免「线性拉伸」的机械感
          const eased = coverMix * coverMix * (3 - 2 * coverMix)
          renderer?.setCoverMix(eased)

          // ---- 诊断：专辑封面成形的判定链路 ----
          // 专辑封面不出现的典型原因都在这里：nextPreset 丢失（undefined 时 < 0.5 为 false）、
          // hasCover 未置位、或 coverMix 被 epoch 反复归零。以下只在状态跨越时打一次，避免刷屏。
          if (nextPreset !== lastLoggedPresetRef.current) {
            lastLoggedPresetRef.current = nextPreset
            console.warn(
              '[particle] 预设生效 nextPreset=', nextPreset,
              'typeof=', typeof nextPreset,
              'hasCover=', hasCoverRef.current,
              '→封面目标 target=', target,
            )
          }
          if (eased > 0.9 && !coverFormedLoggedRef.current) {
            coverFormedLoggedRef.current = true
            console.warn('[particle] 专辑封面已成形 coverMix=', eased.toFixed(3))
          } else if (eased < 0.1 && coverFormedLoggedRef.current) {
            coverFormedLoggedRef.current = false
          }
          // 每 2 秒一条摘要：预设 0 下即使什么都不变也能看到 coverMix 是否在推进，
          // 这是区分「hasCover 没置位」与「coverMix 被反复归零」的决定性证据。
          if (now - lastCoverSummaryAtRef.current > 2000) {
            lastCoverSummaryAtRef.current = now
            console.warn(
              '[particle] 封面状态 backend=', r.backend,
              'preset=', nextPreset,
              'hasCover=', hasCoverRef.current,
              'epoch=', coverEpochRef.current,
              'coverMix=', coverMix.toFixed(3),
              'eased=', eased.toFixed(3),
              'target=', target,
            )
          }

          // 静息时极缓慢自转，避免画面完全静止
          if (mode === 'none' && touchMode === 'none') rig.theta += 0.00035

          // ---- 频谱响应整形：逐式对齐 Mineradio 的 11-main-loop 管线 ----
          // 其送进着色器的并不是原始分析值，而是经过「缩放 + 上限 + 预设分组压缩」后的值，
          // 有效幅度只有原始值的 30%~50%。此前直接传原始值，导致律动明显过大。
          const FX_INTENSITY = 0.85 // 对应其「律动强度」滑块默认值
          const c01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
          let aBass = Math.min(0.9, frame.bass * 1.05 + frame.pulse * 0.18) * FX_INTENSITY
          let aMid = Math.min(0.72, frame.mid * 1.12) * FX_INTENSITY
          let aTreble = Math.min(0.62, frame.treble * 1.2) * FX_INTENSITY
          let aBeat = frame.pulse
          const aEnergy = Math.max(frame.energy, frame.pulse * 0.3)
          if (nextPreset >= 4) {
            const isWallpaper = nextPreset === 5
            const isAuthored = nextPreset >= 9 && nextPreset <= 12
            const bg = isWallpaper ? 1.1 : isAuthored ? 1.32 : 1.58
            const mg = isWallpaper ? 1.16 : isAuthored ? 1.48 : 1.82
            const tg = isWallpaper ? 1.34 : isAuthored ? 1.72 : 2.28
            const qg = isWallpaper ? 0.18 : isAuthored ? 0.31 : 0.42
            const ringBass =
              frame.bass * bg + frame.pulse * qg - frame.mid * 0.16 - frame.treble * 0.06
            const ringMid = frame.mid * mg - frame.bass * 0.14 - frame.treble * 0.07
            const ringTreble = frame.treble * tg - frame.mid * 0.1 - frame.bass * 0.05
            aBass = Math.pow(c01((ringBass - 0.05) / 0.58), 0.72) * FX_INTENSITY
            aMid = Math.pow(c01((ringMid - 0.045) / 0.46), 0.78) * FX_INTENSITY
            aTreble = Math.pow(c01((ringTreble - 0.03) / 0.34), 0.84) * FX_INTENSITY
            if (isWallpaper) {
              aBass = Math.min(aBass, 0.46 * FX_INTENSITY)
              aMid = Math.min(aMid, 0.4 * FX_INTENSITY)
              aTreble = Math.min(aTreble, 0.36 * FX_INTENSITY)
              aBeat *= 0.34
            } else if (isAuthored) {
              aBass = Math.min(aBass, 0.72 * FX_INTENSITY)
              aMid = Math.min(aMid, 0.62 * FX_INTENSITY)
              aTreble = Math.min(aTreble, 0.58 * FX_INTENSITY)
              aBeat *= 0.72
            }
          }

          renderer?.update(
            {
              time: (now - start) / 1000,
              bass: aBass,
              mid: aMid,
              treble: aTreble,
              energy: aEnergy,
              pulse: aBeat,
              ripples: frame.ripples,
            },
            { radius: rig.radius, theta: rig.theta, phi: rig.phi, target: rig.target },
          )
          renderer?.render()
        }
        raf = requestAnimationFrame(loop)

        const scheduleResize = () => {
          if (resizeTimer) clearTimeout(resizeTimer)
          resizeTimer = setTimeout(() => {
            resizeTimer = null
            resize()
          }, 120)
        }
        const observer =
          typeof ResizeObserver !== 'undefined' ? new ResizeObserver(scheduleResize) : null
        if (observer) observer.observe(mount)
        else window.addEventListener('resize', scheduleResize)
        ;(mount as HTMLElement & { __particleObserver?: ResizeObserver }).__particleObserver =
          observer ?? undefined
      })
      .catch((err: unknown) => {
        const message =
          err instanceof ParticleBackendUnavailableError
            ? err.message
            : err instanceof Error
              ? err.message
              : '粒子渲染器初始化失败'
        onError?.(message)
      })

    return () => {
      disposed = true
      if (raf !== null) cancelAnimationFrame(raf)
      if (resizeTimer) clearTimeout(resizeTimer)
      const observer = (mount as HTMLElement & { __particleObserver?: ResizeObserver })
        .__particleObserver
      observer?.disconnect()
      detachEvents()
      if (audio) {
        audio.removeEventListener('play', onAudioPlay)
        audio.removeEventListener('playing', onAudioPlay)
        window.removeEventListener('pointerdown', onGesture, { capture: true })
        window.removeEventListener('touchstart', onGesture, { capture: true })
        window.removeEventListener('click', onGesture, { capture: true })
      }
      renderer?.dispose()
      rendererRef.current = null
    }
    // 场景只初始化一次；动态值通过 liveRef 读取。
    // coverUrl 刻意不在依赖里：换封面只需替换纹理，重建整个场景会打断播放动画。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audio, grid, preference])

  // ---------- 封面加载（独立于场景生命周期） ----------
  useEffect(() => {
    if (!coverUrl) {
      hasCoverRef.current = false
      pendingCoverRef.current = null
      rendererRef.current?.setCover(null)
      return
    }

    const controller = new AbortController()
    let cancelled = false

    void loadCoverTexture(coverUrl, controller.signal).then(cover => {
      if (cancelled) return
      if (!cover || !cover.hasImage) {
        // 取不到封面不是错误：粒子停在星云形态即可，不影响播放
        hasCoverRef.current = false
        pendingCoverRef.current = null
        rendererRef.current?.setCover(null)
        return
      }
      hasCoverRef.current = true
      pendingCoverRef.current = cover
      rendererRef.current?.setCover(cover)
      // 可选 AI 深度增强：后台跑，成功则只替换 R 通道；失败静默沿用启发式深度
      if (cover.edgeCanvas) {
        void enhanceCoverDepth(cover.canvas, cover.edgeCanvas).then(upgraded => {
          if (cancelled || !upgraded) return
          const nextCover: CoverTexture = { ...cover, edgeCanvas: upgraded }
          pendingCoverRef.current = nextCover
          rendererRef.current?.setCover(nextCover)
        })
      }
      // 代次 +1：渲染循环下一帧把 coverMix 归零，形成「散开 → 聚成新封面」的过渡
      coverEpochRef.current += 1
    })

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [coverUrl])

  return (
    <div
      ref={mountRef}
      aria-hidden="true"
      data-backend={backend ?? 'pending'}
      className={`h-full w-full ${className}`}
    />
  )
}
