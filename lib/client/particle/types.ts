/**
 * 粒子渲染抽象层 —— 后端无关的接口定义。
 *
 * 上层组件（ParticleScene）只依赖本接口，不感知底层是 WebGPU 还是 WebGL 2.0，
 * 因此两条路径的交互（Maya 镜头 / 多指手势）与视觉参数完全一致。
 *
 * 设计取舍：粒子运动被建模为
 *     位置 = f(初始位置, 时间, 音频特征)
 * 的纯函数，不存在需要跨帧持久化的状态，因此 WebGL 2.0 路径在顶点着色器里
 * 直接求值即可（零 CPU、零显存回读），无需 Transform Feedback 的 ping-pong 读写。
 * 若未来引入需要状态积分的力场模拟（粒子间相互作用），可在同一接口下新增
 * Transform Feedback 实现而不影响上层。
 */

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
  /** 节拍脉冲 0..1（触发后指数衰减） */
  beat: number
}

/** 镜头状态（球坐标 + 注视点），由上层控制器维护并下发。 */
export interface CameraState {
  radius: number
  theta: number
  phi: number
  target: readonly [number, number, number]
}

export interface ParticleRendererOptions {
  container: HTMLElement
  /** 粒子数量（grid×grid） */
  count: number
  /** 粒子基础尺寸倍率 */
  pointSize: number
  /** 云团基准半径 */
  radius?: number
}

export interface ParticleRenderer {
  /** 实际生效的后端（用于 UI 展示与诊断）。 */
  readonly backend: BackendKind
  /** 粒子数量。 */
  readonly count: number
  /** 尺寸变化。 */
  resize(width: number, height: number): void
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
