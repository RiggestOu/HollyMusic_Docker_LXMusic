/**
 * 节拍追踪与涟漪调度 —— 双后端共用的「律动」数据源。
 *
 * 粒子「跟着节奏跳动」的实现前提是先有一个干净的节拍包络。这里相对上一版
 * （`ParticleScene` 内联的 bass 上升沿比较）做了四处修正：
 *
 * 1. **dt 归一化**。上一版的 `beatDecay *= 0.9` 是「每帧」系数，30FPS 与 120FPS
 *    下同一段音乐给出的脉冲完全不同（帧率越高衰减越快、律动越弱）——这既是观感
 *    bug 也是掉帧设备上的隐性差异。这里所有平滑/衰减都写成 `1 - exp(-dt / τ)` 与
 *    `exp(-dt · τ)` 形式，与帧率解耦。
 * 2. **三频段独立 onset**。只看低频上升沿会漏掉军鼓/镲/合成器切分；改为 bass / mid
 *    / treble 各自做 flux 检测，按权重合成一次触发。
 * 3. **自适应阈值**。固定阈值在安静段落疯狂误触、在密集段落完全哑火。这里对每段
 *    flux 维护一条慢速 EMA 基线，阈值 = 基线 × 倍数 + 地板值。
 * 4. **触发与回落分离**。触达用最陡斜率（节拍本就该「一下子上来」），回落用指数
 *    曲线；输出前由着色器再做 smoothstep 缓动，因此位移/尺寸/亮度都不会出现阶跃。
 *
 * 每次有效触发还会登记一枚涟漪（高斯鼓包 + 扩张环）。着色器据此画出从中心扩散的
 * 平滑冲击波——这是「流体/柔光」质感里最有辨识度的一层，也是纯正弦律动给不了的。
 *
 * 许可证：本文件为独立实现，未复制 Mineradio（GPL-3.0）源码。
 */

/** 同时在场的最大涟漪数（与着色器里 `uRipples[4]` 的数组长度必须一致）。 */
export const MAX_RIPPLES = 4

/** 涟漪寿命（秒）。与 Mineradio 的 2.0s 取值一致，留足扩散与淡出的时间。 */
export const RIPPLE_LIFE = 2.0

/** 瞬时频段能量（0..1，未平滑）。 */
export interface BandFeature {
  bass: number
  mid: number
  treble: number
  energy: number
}

export interface BeatFrame {
  /** 已平滑的频段能量 0..1。 */
  bass: number
  mid: number
  treble: number
  energy: number
  /** 节拍脉冲 0..1：快攻缓落，供着色器做 smoothstep 缓动后驱动跳动/闪烁。 */
  pulse: number
  /** 本帧触发强度 0..1（0 表示未触发），供 UI 指示或额外特效使用。 */
  onset: number
  /**
   * 涟漪数据，长度 {@link MAX_RIPPLES}×4，每枚为 `vec4(age, strength, x, y)`。
   * `age < 0` 表示该槽位空闲。数组实例恒定复用、原地写入，
   * 供两条后端每帧直接拷入 uniform（与 `remoteSpectrum` 同一约定）。
   */
  ripples: Float32Array
}

export interface BeatTracker {
  /** 推进一帧。`dt` 单位秒。 */
  update(dt: number, raw: BandFeature): BeatFrame
  /** 手动登记一枚涟漪（指针点击等外部交互用）。 */
  triggerRipple(x: number, y: number, strength: number): void
  /** 切歌 / 长时间暂停后重置，避免残留包络导致一次假触发。 */
  reset(): void
}

interface Ripple {
  age: number
  strength: number
  x: number
  y: number
}

/** 频段平滑时间常数（秒）：越短越跟手，越长越柔和。 */
const TAU_BASS = 0.10
const TAU_MID = 0.09
const TAU_TREBLE = 0.07
const TAU_ENERGY = 0.12
/** flux 基线（自适应阈值参考）的时间常数，取较大值以代表「最近几秒的音乐性格」。 */
const TAU_FLUX_BASELINE = 1.10

/** 脉冲回落速率（1/秒）：约 0.45s 衰减到峰值的 1/10，听感上刚好卡在下一拍之前。 */
const PULSE_DECAY = 5.0

/** 各频段对「一次节拍」的贡献权重：鼓点最重，镲最轻。 */
const ONSET_WEIGHT = { bass: 1.0, mid: 0.62, treble: 0.34 } as const

/** 触发涟漪所需的最低强度，避免安静段落被噪声刷屏。 */
const RIPPLE_MIN_STRENGTH = 0.22

/** 与帧率解耦的指数平滑系数。 */
function smoothing(dt: number, tau: number): number {
  return 1 - Math.exp(-dt / tau)
}

/** 与帧率解耦的指数衰减系数。 */
function decay(dt: number, rate: number): number {
  return Math.exp(-dt * rate)
}

/**
 * 非对称包络平滑（对齐 Mineradio 的 env()）：上升用较短时间常数（attack，跟手），
 * 回落用较长时间常数（release，柔和）。dt 归一化，与帧率解耦。
 * tau 取值由 Mineradio 的 attack/release 系数（0.28 / 0.075 等，按 60fps 假设）反推：
 *   tau = -(1/60) / ln(1 - k)
 */
function envAt(prev: number, next: number, tauAtt: number, tauRel: number, dt: number): number {
  const rising = next > prev
  const k = 1 - Math.exp(-dt / (rising ? tauAtt : tauRel))
  return prev + (next - prev) * k
}

export function createBeatTracker(): BeatTracker {
  // 频段包络（用于 onset 检测的 flux 基准，沿用原逻辑）
  let bass = 0
  let mid = 0
  let treble = 0
  let energy = 0
  // flux 慢速基线（自适应阈值的参考量）
  let bassBase = 0
  let midBase = 0
  let trebleBase = 0
  let pulse = 0
  // ---- Mineradio 频谱响应对齐：动态峰值 + 非对称 env 平滑状态 ----
  // 近期峰值（缓慢衰减），作为归一化分母；地板值防止静音段落被底噪触发
  let bassPeak = 0.03
  let midPeak = 0.026
  let treblePeak = 0.018
  let energyPeak = 0.03
  // 非对称 env 平滑后的输出（对齐 Mineradio 的 smoothBass/smoothMid/smoothTreb）
  let smoothBass = 0
  let smoothMid = 0
  let smoothTreb = 0

  const ripples: Ripple[] = []
  for (let i = 0; i < MAX_RIPPLES; i++) {
    ripples.push({ age: -1, strength: 0, x: 0, y: 0 })
  }
  const rippleBuffer = new Float32Array(MAX_RIPPLES * 4)

  const frame: BeatFrame = {
    bass: 0,
    mid: 0,
    treble: 0,
    energy: 0,
    pulse: 0,
    onset: 0,
    ripples: rippleBuffer,
  }

  function pushRipple(x: number, y: number, strength: number): void {
    // 取「最旧」的一枚复用：age 最大即为最接近生命末期的槽位；
    // 空闲槽位（age < 0）优先级最高，这样连续触发时不会立刻顶掉刚出现的涟漪。
    let target = 0
    for (let i = 0; i < MAX_RIPPLES; i++) {
      const r = ripples[i]
      if (r.age < 0) {
        target = i
        break
      }
      if (r.age > ripples[target].age) target = i
    }
    const slot = ripples[target]
    slot.age = 0
    slot.strength = Math.max(0, Math.min(1, strength))
    slot.x = x
    slot.y = y
  }

  function advanceRipples(dt: number): void {
    for (let i = 0; i < MAX_RIPPLES; i++) {
      const r = ripples[i]
      if (r.age >= 0) {
        r.age += dt
        if (r.age > RIPPLE_LIFE) r.age = -1
      }
      const o = i * 4
      rippleBuffer[o] = r.age
      rippleBuffer[o + 1] = r.age < 0 ? 0 : r.strength
      rippleBuffer[o + 2] = r.x
      rippleBuffer[o + 3] = r.y
    }
  }

  /**
   * 单频段 onset 检测。
   * @returns 归一化触发强度 0..1
   */
  function detectOnset(
    value: number,
    envelope: number,
    baseline: number,
    dt: number,
  ): { strength: number; baseline: number } {
    const flux = value - envelope
    const nextBaseline =
      baseline + (Math.max(0, flux) - baseline) * smoothing(dt, TAU_FLUX_BASELINE)
    // 自适应阈值：近期 flux 基线的倍数 + 地板值（地板值防止静音段落被底噪触发）
    const threshold = nextBaseline * 2.2 + 0.012
    if (flux <= threshold || flux < 0.004) return { strength: 0, baseline: nextBaseline }
    // 超出阈值的相对幅度映射到 0..1：刚好越线≈0，两倍阈值≈0.5
    const strength = Math.min(1, (flux - threshold) / (threshold + 0.02))
    return { strength, baseline: nextBaseline }
  }

  return {
    update(dt: number, raw: BandFeature): BeatFrame {
      // 夹紧 dt：标签页切回来 / 断点调试后 dt 可能是几百毫秒，
      // 不夹紧会让包络一步跳过整段音乐，产生一次莫名其妙的巨幅爆散。
      const step = Math.min(0.05, Math.max(1 / 240, dt))

      const kBass = smoothing(step, TAU_BASS)
      const kMid = smoothing(step, TAU_MID)
      const kTreble = smoothing(step, TAU_TREBLE)
      const kEnergy = smoothing(step, TAU_ENERGY)

      const bassOnset = detectOnset(raw.bass, bass, bassBase, step)
      const midOnset = detectOnset(raw.mid, mid, midBase, step)
      const trebleOnset = detectOnset(raw.treble, treble, trebleBase, step)

      bassBase = bassOnset.baseline
      midBase = midOnset.baseline
      trebleBase = trebleOnset.baseline

      // 先更新包络（用于 onset flux 基准），再算脉冲，保证同一帧里的 onset 与包络一致
      bass += (raw.bass - bass) * kBass
      mid += (raw.mid - mid) * kMid
      treble += (raw.treble - treble) * kTreble
      energy += (raw.energy - energy) * kEnergy

      // 脉冲：先按 dt 衰减，再叠加本帧触发（快攻缓落）
      pulse *= decay(step, PULSE_DECAY)
      const onset = Math.min(
        1,
        bassOnset.strength * ONSET_WEIGHT.bass +
          midOnset.strength * ONSET_WEIGHT.mid +
          trebleOnset.strength * ONSET_WEIGHT.treble,
      )
      if (onset > 0) {
        pulse = Math.min(1, pulse + onset)
        if (onset >= RIPPLE_MIN_STRENGTH) pushRipple(0, 0, onset)
      }

      // ---- Mineradio 频谱响应对齐：动态峰值归一化 + 非对称 env 平滑 ----
      // 峰值跟踪（11-main-loop.js:394-397）：近期峰值缓慢衰减，作为归一化分母，
      // 让「相对当前段落峰值」的律动幅度稳定，安静段落不会因绝对能量高而自嗨。
      bassPeak = Math.max(bassPeak * 0.994, raw.bass, 0.030)
      midPeak = Math.max(midPeak * 0.993, raw.mid, 0.026)
      treblePeak = Math.max(treblePeak * 0.992, raw.treble, 0.018)
      energyPeak = Math.max(energyPeak * 0.995, raw.energy, 0.030)
      // 归一化（11-main-loop.js:399-402）：相对峰值取比值再做 pow 提升小值，裁剪到 1
      const rb = Math.min(1, Math.pow(raw.bass / Math.max(0.038, bassPeak * 0.66), 0.78))
      const rm = Math.min(1, Math.pow(raw.mid / Math.max(0.025, midPeak * 0.70), 0.86))
      const rt = Math.min(1, Math.pow(raw.treble / Math.max(0.020, treblePeak * 0.74), 0.92))
      const re = Math.min(1, Math.pow(raw.energy / Math.max(0.034, energyPeak * 0.68), 0.82))
      // 非对称 env 平滑（11-main-loop.js:484-487）：attack 快、release 慢，dt 归一化
      smoothBass = envAt(smoothBass, Math.min(0.82, rb * 0.78 + re * 0.025), 0.0507, 0.2138, step)
      smoothMid = envAt(smoothMid, Math.min(0.68, rm * 0.64 + re * 0.025), 0.0840, 0.2693, step)
      smoothTreb = envAt(smoothTreb, Math.min(0.56, rt * 0.54), 0.0840, 0.2693, step)

      advanceRipples(step)

      frame.bass = smoothBass
      frame.mid = smoothMid
      frame.treble = smoothTreb
      frame.energy = energy
      frame.pulse = pulse
      frame.onset = onset
      return frame
    },

    triggerRipple(x: number, y: number, strength: number): void {
      pushRipple(x, y, strength)
    },

    reset(): void {
      bass = mid = treble = energy = 0
      bassBase = midBase = trebleBase = 0
      pulse = 0
      for (let i = 0; i < MAX_RIPPLES; i++) {
        ripples[i].age = -1
        ripples[i].strength = 0
      }
      advanceRipples(0)
    },
  }
}
