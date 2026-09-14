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
}

export const DEFAULT_FX: FxSettings = {
  intensity: 0.85,
  speed: 1.0,
  depth: 0.2,
  twist: 0,
  scatter: 0,
  bloom: 0.62,
  edge: 1,
  bgFade: 0.2,
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
