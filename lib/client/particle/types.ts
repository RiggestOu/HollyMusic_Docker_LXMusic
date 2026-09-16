/**
 * 粒子渲染抽象层 —— 后端无关的接口定义。
 *
 * 上层组件（ParticleScene）只依赖本接口，不感知底层是 WebGPU 还是 WebGL 2.0，
 * 因此两条路径的交互（Maya 镜头 / 多指手势）与视觉参数完全一致。
 *
 * # 粒子运动模型
 * 每个粒子有两个「归宿形态」，由 `coverMix` 在两者之间平滑插值：
 *   · 星云形态（cloud）：球面随机分布 + 噪声流场漂移；
 *   · 封面形态（cover）：铺在一块平面上，按 `aUv` 采样专辑封面颜色，
 *     因此粒子能拼出可辨认的专辑图，Z 轴由音频驱动起伏。
 * 两种形态之间用同一个插值因子做连续过渡（「散开 → 聚拢成图」），
 * 而不是切换两套几何 —— 后者必然出现粒子跳位。
 *
 * 设计取舍：星云形态的运动被建模为
 *     位置 = f(初始锚点, 时间, 音频特征)
 * 的纯函数；封面形态同样不需要跨帧持久化状态。因此 WebGL 2.0 路径在顶点着色器里
 * 直接求值即可（零 CPU、零显存回读），无需 Transform Feedback 的 ping-pong 读写。
 * WebGPU 路径则用 compute shader 做弹簧趋近（保持真正的状态演化）——两条路径都
 * 收敛到「目标位置 + 平滑扰动」这一同一模型，观感因此一致。
 */

import type { CoverTexture } from './cover-texture'

/** 渲染后端类型。 */
export type BackendKind = 'webgpu' | 'webgl2'

/** 每帧的音频特征（已平滑），驱动粒子律动。 */
export interface AudioFeatures {
  /** 秒 */
  time: number
  /** 低频 0..1 */
  bass: number
  /** 中频 0..1 */
  mid: number
  /** 高频 0..1 */
  treble: number
  /** 整体能量 0..1 */
  energy: number
  /**
   * 节拍脉冲 0..1：快攻缓落包络。
   * 着色器应再套一层 `smoothstep` 缓动后再用于位移/尺寸/亮度，
   * 这样节拍「一下子上来」的手感保留，但不会出现阶跃式突变。
   */
  pulse: number
  /**
   * 涟漪数据，长度 4×4，每枚为 `vec4(age, strength, x, y)`，`age < 0` 表示空闲。
   * 实例恒定复用、原地写入（与 `remoteSpectrum` 同一约定），后端每帧拷入 uniform。
   */
  ripples: Float32Array
}

/** 镜头状态（球坐标 + 注视点），由上层控制器维护并下发。 */
export interface CameraState {
  radius: number
  theta: number
  phi: number
  target: readonly [number, number, number]
}

/** 动效参数（与 Mineradio 的 fx 滑块一一对应；默认值即其出厂默认）。 */
export interface FxSettings {
  /** 律动强度 0.2~1.6，默认 0.85 → K = intensity * 1.6 */
  intensity: number
  /** 运动速度 0.2~2.5，默认 1.0 */
  speed: number
  /** 画面景深 0.2~1.8，默认 0.20 */
  depth: number
  /** 粒子扭曲 0~0.6，默认 0 */
  twist: number
  /** 离散感 0~0.5，默认 0 */
  scatter: number
  /** 光晕强度 0~1.6，默认 0.62（以此为 1.0 基准） */
  bloom: number
  /** 轮廓高亮开关，默认开 */
  edge: number
  /** 背景压暗 0~1.2，默认 0.20 */
  bgFade: number

  // ---- 实验调参（2026-09-15 新增）----
  // 下面这些原本是**硬编码在着色器里**的常数，无法实时调节，排查「到底是哪个参数在影响观感」
  // 只能反复改代码 + 重新构建。现统一提升为 uniform 暴露到「实验调参」面板。
  // 默认值 = 着色器里原来的字面量（即当前观感不变），因此加这些字段不会改变默认效果。
  /** 频谱振幅总倍率：bass/mid/treble 进入着色器前的缩放。1 = 原始强度 */
  spectrumAmp: number
  /** 流场位移基数（webgl2 flowAmp 的常数项） */
  flowBase: number
  /** 流场位移·低频系数 */
  flowBass: number
  /** 流场位移·中频系数 */
  flowMid: number
  /** 涟漪抬升位移 */
  rippleAmp: number
  /** 涟漪亮度系数（原硬编码 0.52/0.34/0.64/0.55，可调） */
  rippleBright: number
  /** 节拍跳动位移基数（配合 pulseBass） */
  pulseBase: number
  /** 节拍跳动位移·低频系数 */
  pulseBass: number
  /** 预设切换爆散位移 */
  burstAmp: number
  /** 封面形态 Z 浮雕强度倍率 */
  reliefAmp: number
  /** 点尺寸基数（Mineradio depthSize = 36 / 视深） */
  sizeBase: number
  /** 点尺寸上限（px） */
  sizeMax: number
  /** 亮度基数（vBright 的常数项） */
  brightBase: number
  /** 透明度基数（alpha 的常数项） */
  alphaBase: number
}

export const DEFAULT_FX: FxSettings = {
  intensity: 0.85,
  speed: 1.0,
  depth: 0.2,
  twist: 0,
  scatter: 0,
  bloom: 3.0,
  edge: 1,
  bgFade: 0.2,
  // 实验调参默认值（= 原着色器字面量；2026-09-15 按用户实测观感调整过 4 项）
  spectrumAmp: 0.06,
  flowBase: 0.55,
  flowBass: 1.6,
  flowMid: 0.65,
  rippleAmp: 0.13,
  rippleBright: 1.0,
  pulseBase: 0.03,
  pulseBass: 0.9,
  burstAmp: 1.6,
  reliefAmp: 1.0,
  sizeBase: 36.0,
  sizeMax: 4.95,
  brightBase: 0.7,
  alphaBase: 0.55,
}

/**
 * 上述「实验调参」键名，供面板渲染开关与滑杆、以及 store 做归零解析。
 * 关掉某个开关 → 该参数按 0 下发给着色器（用于逐个隔离定位是哪个参数在影响观感）。
 */
export const TUNING_KEYS = [
  'spectrumAmp',
  'flowBase',
  'flowBass',
  'flowMid',
  'rippleAmp',
  'rippleBright',
  'pulseBase',
  'pulseBass',
  'burstAmp',
  'reliefAmp',
  'sizeBase',
  'sizeMax',
  'brightBase',
  'alphaBase',
] as const

export type TuningKey = (typeof TUNING_KEYS)[number]

/** 调参项元信息：滑杆范围与说明（面板与默认值共用一套，避免两处漂移）。 */
export const TUNING_META: Record<TuningKey, { label: string; min: number; max: number; step: number; desc: string }> = {
  spectrumAmp: { label: '频谱振幅', min: 0, max: 2, step: 0.01, desc: 'bass/mid/treble 总倍率，关掉=完全不受音乐影响' },
  flowBase: { label: '流场·基数', min: 0, max: 5, step: 0.01, desc: '流场位移常数项，关掉=无流动' },
  flowBass: { label: '流场·低频', min: 0, max: 5, step: 0.01, desc: '流场位移中 bass 的系数' },
  flowMid: { label: '流场·中频', min: 0, max: 5, step: 0.01, desc: '流场位移中 mid 的系数' },
  rippleAmp: { label: '涟漪抬升', min: 0, max: 8, step: 0.01, desc: '点击涟漪的 Z 轴抬升量' },
  rippleBright: { label: '涟漪亮度', min: 0, max: 5, step: 0.01, desc: '涟漪区域亮度系数（发白时调低）' },
  pulseBase: { label: '节拍·基数', min: 0, max: 5, step: 0.01, desc: '每拍径向跳动的基础位移' },
  pulseBass: { label: '节拍·低频', min: 0, max: 5, step: 0.01, desc: '节拍跳动中 bass 的系数' },
  burstAmp: { label: '切换爆散', min: 0, max: 10, step: 0.01, desc: '切预设时向外炸开的位移' },
  reliefAmp: { label: '封面浮雕', min: 0, max: 3, step: 0.01, desc: '封面形态 Z 轴浮雕/呼吸强度' },
  sizeBase: { label: '点尺寸·基数', min: 1, max: 120, step: 0.5, desc: 'Mineradio 原式 36 / 视深' },
  sizeMax: { label: '点尺寸·上限', min: 0.5, max: 20, step: 0.05, desc: '粒子像素直径上限' },
  brightBase: { label: '亮度·基数', min: 0, max: 3, step: 0.01, desc: 'vBright 常数项' },
  alphaBase: { label: '透明度·基数', min: 0, max: 1, step: 0.01, desc: 'alpha 常数项' },
}

export interface ParticleRendererOptions {
  container: HTMLElement
  /** 粒子数量（grid×grid） */
  count: number
  /** 粒子基础尺寸倍率 */
  pointSize: number
  /** 云团基准半径 */
  radius?: number
  /** 封面平面边长（世界单位）。粒子按 UV 铺满这个正方形。 */
  plane?: number
  /**
   * 星河背景层粒子数（与预设无关，始终存在）。
   * 它们被放在同一个粒子缓冲里，用每粒子的 `kind` 字段区分，
   * 因此不需要第二条管线，也不会被预设切换影响。
   */
  starCount?: number
}

export interface ParticleRenderer {
  /** 实际生效的后端（用于 UI 展示与诊断）。 */
  readonly backend: BackendKind
  /** 粒子数量。 */
  readonly count: number
  /** 尺寸变化。 */
  resize(width: number, height: number): void
  /**
   * 替换封面纹理源。
   *
   * 约定：`cover.canvas` 必须是**固定尺寸**（见 `COVER_TEXTURE_SIZE`）的方形画布，
   * 后端据此复用已创建的纹理对象、只覆盖像素内容，因此不会重建绑定组、
   * 也不会出现切歌瞬间的黑屏或掉帧。传 `null` 退回占位图。
   *
   * `luminance` 用于让极暗封面对应更大幅度的整体提亮 —— 否则整张专辑图
   * 会糊成一片近黑的粒子，什么都读不出来。
   */
  setCover(cover: CoverTexture | null): void
  /**
   * 设置形态插值因子：0 = 星云形态，1 = 封面形态。
   *
   * 缓动由上层负责（上层知道 dt，也知道是不是刚切歌），
   * 后端只做线性使用 —— 避免两条后端各自实现一套缓动导致观感漂移。
   */
  setCoverMix(mix: number): void
  /**
   * 下发骷髅点云坐标（预设 6 专用）。写入粒子的 anchor 槽位；
   * 传 null 表示尚未加载，此时预设 6 退化为当前占位表现。
   */
  setSkullPoints(positions: Float32Array | null): void
  /** 下发动效参数（滑块实时调节）。 */
  setFx(fx: FxSettings): void
  /**
   * 切换粒子视觉预设（0..12，见 PRESETS 常量表）。
   *
   * 后端只负责保存当前值；**平滑过渡由上层驱动**：上层在切换的同一帧调用
   * {@link setPresetBurst} 传入 1，粒子会先向外炸开、再被弹簧拉向新预设的形状，
   * 因此不会出现「整团粒子瞬移到另一个几何」的硬切。
   */
  setPreset(preset: number): void
  /**
   * 预设切换的爆散强度 0..1。
   * 上层按 dt 指数回落（1 → 0），后端只把它当作径向冲量/位移的强度系数。
   */
  setPresetBurst(value: number): void
  /** 更新 uniform / 存储缓冲（音频特征 + 镜头）。 */
  update(features: AudioFeatures, camera: CameraState): void
  /** 绘制一帧。 */
  render(): void
  /** 释放 GPU 资源。 */
  dispose(): void
}

/** 由球坐标计算相机位置（两条后端共用，保证视觉一致）。 */
export function cameraPosition(c: CameraState): [number, number, number] {
  const sp = Math.sin(c.phi)
  return [
    c.target[0] + c.radius * sp * Math.sin(c.theta),
    c.target[1] + c.radius * Math.cos(c.phi),
    c.target[2] + c.radius * sp * Math.cos(c.theta),
  ]
}

/** 基准垂直 FOV：对齐 Mineradio 的 BASE_FOV。 */
export const BASE_FOV = 45

/** 设计基准宽高比（视为「全屏」）。 */
export const BASE_ASPECT = 16 / 9

/** FOV 允许范围：对齐 Mineradio 滚轮缩放用的 clampRange(.., 26, 72)。 */
export const FOV_MIN = 26
export const FOV_MAX = 72

/**
 * 锁定「水平视野」的垂直 FOV。
 *
 * three 的 PerspectiveCamera 只暴露垂直 FOV。容器宽高比一变，水平取景范围就随之变化，
 * 于是同一个场景在窄容器里会「画面变大、左右被裁掉」——这与全屏下的左右占屏比例不一致。
 *
 * 这里以「基准宽高比下的水平 FOV」为不变量，反解出当前宽高比所需的垂直 FOV，
 * 再由 {@link FOV_MIN}/{@link FOV_MAX} 兜住极端比例，保证不会退化成广角畸变。
 */
export function verticalFovForAspect(aspect: number): number {
  const safe = Number.isFinite(aspect) && aspect > 0 ? aspect : BASE_ASPECT
  const baseV = (BASE_FOV * Math.PI) / 180
  // 基准宽高比下的水平 FOV（不变量）
  const hFov = 2 * Math.atan(Math.tan(baseV / 2) * BASE_ASPECT)
  const v = (2 * Math.atan(Math.tan(hFov / 2) / safe) * 180) / Math.PI
  return Math.min(FOV_MAX, Math.max(FOV_MIN, v))
}
