/**
 * 粒子渲染器工厂 —— 特性检测与自动降级。
 *
 * 选型顺序：
 *   1. WebGPU（navigator.gpu + adapter 可用）  → Compute Shader 路径
 *   2. WebGL 2.0（canvas 支持 webgl2）         → 顶点位移路径
 *   3. 都不支持 → 抛错（由上层展示提示，不静默失败）
 *
 * 可用 preference 强制指定后端（设置项「自动 / 强制 WebGPU / 强制 WebGL 2.0」）：
 * 强制 WebGPU 失败时会继续回落到 WebGL 2.0，避免用户拿到黑屏。
 */

import type { ParticleRenderer, ParticleRendererOptions } from './types'
import { createWebGL2Renderer } from './webgl2'
import { createWebGPURenderer } from './webgpu'

export type BackendPreference = 'auto' | 'webgpu' | 'webgl2'

export class ParticleBackendUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ParticleBackendUnavailableError'
  }
}

/** WebGPU 探测：navigator.gpu 存在且能拿到 adapter。 */
async function supportsWebGPU(): Promise<boolean> {
  if (typeof navigator === 'undefined') return false
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
  if (!gpu) return false
  try {
    const adapter = await gpu.requestAdapter()
    return !!adapter
  } catch {
    return false
  }
}

/** WebGL 2.0 探测。 */
function supportsWebGL2(): boolean {
  if (typeof document === 'undefined') return false
  try {
    const probe = document.createElement('canvas')
    const gl = probe.getContext('webgl2')
    if (!gl) return false
    // 主动释放探测上下文，避免占用有限的 WebGL context 名额
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return true
  } catch {
    return false
  }
}

/**
 * 创建粒子渲染器。
 *
 * @param options 粒子数量 / 尺寸 / 挂载容器
 * @param preference 后端偏好，默认 'auto'
 * @param onBackendResolved 回调实际生效的后端（供 UI 显示与日志）
 */
export async function createParticleRenderer(
  options: ParticleRendererOptions,
  preference: BackendPreference = 'auto',
  onBackendResolved?: (backend: ParticleRenderer['backend']) => void,
): Promise<ParticleRenderer> {
  // 探测 adapter 是否真的可用（navigator.gpu 存在不代表一定能拿到 device）
  let webgpuOk = false
  if (preference !== 'webgl2') {
    webgpuOk = await supportsWebGPU()
  }

  if (webgpuOk) {
    try {
      const renderer = await createWebGPURenderer(options)
      onBackendResolved?.(renderer.backend)
      return renderer
    } catch {
      // WebGPU 初始化失败（驱动/权限/编译错误）→ 静默降级，不打断播放
    }
  }

  if (preference === 'webgpu') {
    // 强制 WebGPU 但不可用：仍回落，避免黑屏
  }

  if (supportsWebGL2()) {
    const renderer = createWebGL2Renderer(options)
    onBackendResolved?.(renderer.backend)
    return renderer
  }

  throw new ParticleBackendUnavailableError(
    '当前环境不支持 WebGPU 或 WebGL 2.0，无法渲染粒子界面',
  )
}
