/**
 * ParticleScene —— 粒子可视化 React 组件（后端无关）。
 *
 * 职责划分：
 *   · 本组件：音频分析、镜头控制（Maya / 多指手势）、渲染循环、生命周期
 *   · 渲染后端：由 lib/client/particle 的工厂按 WebGPU → WebGL 2.0 顺序创建
 *
 * 两条后端共用同一份音频特征与镜头状态，因此交互与观感完全一致。
 *
 * 音频数据源复用项目既有分析管线（lib/client/audio-analysis）：
 * createMediaElementSource 对同一元素只能调用一次，且 iOS 必须整体禁用接管
 * （详见该模块注释），因此这里绝不自建 AudioContext：
 *   · 手势内 → attachAnalysisPipeline()
 *   · 非手势 → getExistingAnalysisPipeline()
 *   · 拿不到 → spectrumSynth() 合成频谱兜底（iOS / 接管失败）
 *
 * 许可证：本文件为独立实现，仅参考 Mineradio 的视觉架构
 * （点阵粒子 + 音频 uniform 驱动），未复制其 GPL-3.0 源码，不引入 copyleft 传染。
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
import { isMobileLike, suggestedGrid } from '@/lib/utils/device'

export interface ParticleSceneProps {
  /** 当前播放的原生音频元素；为 null 时粒子仅做静息动画。 */
  audio?: HTMLAudioElement | null
  isPlaying?: boolean
  /** 远程模式：外部（如 Tauri IPC）注入的频谱，优先于本地分析。 */
  remoteSpectrum?: Uint8Array | null
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
  /** 滚轮回调：滚轮不控制镜头，转交外层菜单滑块。 */
  onWheelMenu?: (deltaY: number) => void
  /** 后端就绪回调（供 UI 显示当前渲染后端）。 */
  onBackend?: (backend: BackendKind) => void
  /** 初始化失败回调（如环境不支持 WebGPU/WebGL2）。 */
  onError?: (message: string) => void
  className?: string
}

type DragMode = 'none' | 'rotate' | 'pan' | 'dolly'

export function ParticleScene({
  audio = null,
  isPlaying = false,
  remoteSpectrum = null,
  grid = 160,
  fps = 60,
  pointSize = 1,
  paused = false,
  preference = 'auto',
  onWheelMenu,
  onBackend,
  onError,
  className = '',
}: ParticleSceneProps) {
  const mountRef = useRef<HTMLDivElement>(null)
  const [backend, setBackend] = useState<BackendKind | null>(null)

  /** 供事件回调与渲染循环读取的最新值，避免重建场景。 */
  const liveRef = useRef({ isPlaying, paused, remoteSpectrum, onWheelMenu, fps })
  liveRef.current = { isPlaying, paused, remoteSpectrum, onWheelMenu, fps }

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
    const rig = {
      radius: 15,
      theta: 0.6,
      phi: Math.PI / 2,
      target: [0, 0, 0] as [number, number, number],
    }

    const rotateBy = (dx: number, dy: number) => {
      rig.theta -= dx * 0.0055
      rig.phi = Math.min(Math.PI - 0.12, Math.max(0.12, rig.phi - dy * 0.0055))
    }
    const dollyBy = (dy: number) => {
      rig.radius = Math.min(48, Math.max(3.2, rig.radius * (1 + dy * 0.0022)))
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
      // right = normalize(cross(forward, worldUp))
      let rx = fz * 0 - fy * 0
      let ry = 0
      let rz = 0
      // cross(forward, (0,1,0)) = (fz*1 - fy*0, fx*0 - fz*0, fy*0 - fx*1) = (fz, 0, -fx)
      rx = fz
      ry = 0
      rz = -fx
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
      freqData = new Uint8Array(p.analyser.frequencyBinCount)
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

    let bass = 0
    let mid = 0
    let treble = 0
    let energy = 0
    let beat = 0
    let beatDecay = 0
    let prevBass = 0

    const analyse = (now: number) => {
      const remote = liveRef.current.remoteSpectrum
      let data: Uint8Array
      if (remote && remote.length > 0) {
        data = remote
      } else if (pipeline && freqData && !usingSynth) {
        pipeline.analyser.getByteFrequencyData(freqData)
        data = freqData
      } else {
        spectrumSynth(synthTarget, now)
        for (let i = 0; i < synthSmooth.length; i++) {
          synthSmooth[i] += Math.round((synthTarget[i] - synthSmooth[i]) * 0.22)
        }
        data = synthSmooth
      }

      const n = data.length
      const loEnd = Math.max(1, Math.floor(n * 0.12))
      const midEnd = Math.max(loEnd + 1, Math.floor(n * 0.42))
      let lo = 0
      let mi = 0
      let hi = 0
      for (let i = 0; i < loEnd; i++) lo += data[i]
      for (let i = loEnd; i < midEnd; i++) mi += data[i]
      for (let i = midEnd; i < n; i++) hi += data[i]
      lo = lo / loEnd / 255
      mi = mi / (midEnd - loEnd) / 255
      hi = hi / Math.max(1, n - midEnd) / 255

      const active = liveRef.current.isPlaying || !usingSynth ? 1 : 0
      const k = 0.18
      bass += (lo * active - bass) * k
      mid += (mi * active - mid) * k
      treble += (hi * active - treble) * k
      energy += (((lo + mi + hi) / 3) * active - energy) * k

      const rise = bass - prevBass
      prevBass = bass
      if (rise > 0.055) beatDecay = 1
      beatDecay *= 0.9
      beat += (beatDecay - beat) * 0.35

      return { bass, mid, treble, energy, beat }
    }

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
      { container: mount, count, pointSize },
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
        const start = performance.now()
        const loop = (now: number) => {
          raf = requestAnimationFrame(loop)
          const interval = 1000 / Math.max(1, liveRef.current.fps)
          if (now - lastFrame < interval - 1) return
          lastFrame = now
          if (liveRef.current.paused || document.hidden) return

          const f = analyse(now)
          // 静息时极缓慢自转，避免画面完全静止
          if (mode === 'none' && touchMode === 'none') rig.theta += 0.00035

          renderer?.update(
            {
              time: (now - start) / 1000,
              bass: f.bass,
              mid: f.mid,
              treble: f.treble,
              energy: f.energy,
              beat: f.beat,
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
    }
    // 场景只初始化一次；动态值通过 liveRef 读取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audio, grid, preference])

  return (
    <div
      ref={mountRef}
      aria-hidden="true"
      data-backend={backend ?? 'pending'}
      className={`h-full w-full ${className}`}
    />
  )
}
