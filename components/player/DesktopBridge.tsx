/**
 * DesktopBridge —— 主窗口侧的「隐形」桥接组件（不渲染任何 DOM）。
 *
 * 桌面端把粒子壁纸与桌面歌词放在独立窗口里，它们拿不到主窗口的音频元素，
 * 因此由主窗口负责把两样东西经 IPC 推给外壳，再由外壳转发给对应窗口：
 *   1. 实时频谱（约 30Hz）→ 桌面壁纸
 *   2. 播放状态（约 4Hz：曲目 uid / 进度 / 播放暂停）→ 桌面歌词
 *
 * 频谱来源严格复用既有分析管线（lib/client/audio-analysis）：
 * 不自建 AudioContext、不在非手势时接管音频，避免破坏「createMediaElementSource 只能调用一次」
 * 与 iOS 后台播放这两条既有约束。拿不到管线时用合成频谱兜底。
 *
 * 非桌面端（Web / 移动浏览器）本组件整体空转，零开销。
 */

import { useEffect } from 'react'
import {
  getExistingAnalysisPipeline,
  type AudioAnalysisPipeline,
} from '@/lib/client/audio-analysis'
import { spectrumSynth, SPECTRUM_SYNTH_BINS } from '@/lib/client/spectrum-synth'
import { usePlayerStore } from '@/lib/store/player-store'
import { isDesktop, pushPlaybackState, pushSpectrum } from '@/lib/client/desktop-bridge'

/** 推送给外壳的频段数（降采样后，够用且省 IPC 开销）。 */
const SEND_BINS = 48
const SPECTRUM_INTERVAL_MS = 1000 / 30
const STATE_INTERVAL_MS = 1000 / 4

export function DesktopBridge({ audio }: { audio: HTMLAudioElement | null }) {
  useEffect(() => {
    if (!isDesktop()) return

    let raf: number | null = null
    let pipeline: AudioAnalysisPipeline | null = null
    let freqData: Uint8Array<ArrayBuffer> | null = null

    const synthTarget = new Uint8Array(SPECTRUM_SYNTH_BINS)
    const synthSmooth = new Uint8Array(SPECTRUM_SYNTH_BINS)
    const out: number[] = new Array(SEND_BINS).fill(0)

    let lastSpectrum = 0
    let lastState = 0

    const bind = () => {
      if (!audio || pipeline) return
      const p = getExistingAnalysisPipeline(audio)
      if (!p) return
      pipeline = p
      freqData = new Uint8Array(p.analyser.frequencyBinCount)
    }
    bind()
    audio?.addEventListener('play', bind)
    audio?.addEventListener('playing', bind)

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      if (now - lastSpectrum < SPECTRUM_INTERVAL_MS) return
      lastSpectrum = now

      let data: Uint8Array
      if (pipeline && freqData) {
        pipeline.analyser.getByteFrequencyData(freqData)
        data = freqData
      } else {
        spectrumSynth(synthTarget, now)
        for (let i = 0; i < synthSmooth.length; i++) {
          synthSmooth[i] += Math.round((synthTarget[i] - synthSmooth[i]) * 0.22)
        }
        data = synthSmooth
      }

      // 线性降采样到固定频段数，避免 IPC 载荷随 analyser 尺寸波动
      const n = data.length
      for (let i = 0; i < SEND_BINS; i++) {
        const a = Math.floor((i * n) / SEND_BINS)
        const b = Math.max(a + 1, Math.floor(((i + 1) * n) / SEND_BINS))
        let sum = 0
        for (let j = a; j < b; j++) sum += data[j]
        out[i] = Math.round(sum / (b - a))
      }
      pushSpectrum(out)

      if (now - lastState < STATE_INTERVAL_MS) return
      lastState = now
      const s = usePlayerStore.getState()
      pushPlaybackState({
        uid: s.currentTrack?.uid,
        title: s.currentTrack?.name,
        artist: s.currentTrack?.artist,
        position: s.currentTime,
        duration: s.duration,
        isPlaying: s.isPlaying,
      })
    }
    raf = requestAnimationFrame(loop)

    return () => {
      if (raf !== null) cancelAnimationFrame(raf)
      audio?.removeEventListener('play', bind)
      audio?.removeEventListener('playing', bind)
    }
  }, [audio])

  return null
}
