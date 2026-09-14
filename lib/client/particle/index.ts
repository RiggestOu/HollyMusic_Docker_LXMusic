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

/** WebGPU 探测结果（供诊断面板展示）。 */
export interface WebGpuProbeResult {
  isSecureContext: boolean
  origin: string
  hasGpu: boolean
  hasAdapter: boolean
  adapterSummary?: string
  hasDevice: boolean
  backend: 'webgpu' | 'webgl2' | 'none'
  reason?: string
}

let cachedProbe: WebGpuProbeResult | null = null

/** 同步快速探测 navigator.gpu 是否暴露 + 安全上下文。异步补全 adapter/device 探测。 */
export function probeWebGPU(): WebGpuProbeResult {
  if (typeof window === 'undefined') {
    return { isSecureContext: false, origin: 'ssr', hasGpu: false, hasAdapter: false, hasDevice: false, backend: 'none' }
  }
  const isSecure = window.isSecureContext
  const origin = location.origin
  const hasGpu = !!(navigator as unknown as { gpu?: unknown }).gpu
  const result: WebGpuProbeResult = { isSecureContext: isSecure, origin, hasGpu, hasAdapter: false, hasDevice: false, backend: hasGpu ? 'webgpu' : 'none' }
  if (!hasGpu) {
    result.reason = !isSecure ? `非安全上下文（${origin}）→ 浏览器隐藏 navigator.gpu` : 'navigator.gpu 缺失'
    cachedProbe = result
    return result
  }
  // 异步补全 adapter/device 探测
  ;(async () => {
    const p: WebGpuProbeResult = { ...result }
    try {
      const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
      const adapter: any = await gpu?.requestAdapter?.()
      p.hasAdapter = !!adapter
      if (adapter) {
        const info = await adapter.requestAdapterInfo?.() as any
        const name = info?.name ?? info?.adapter ?? adapter.toString?.() ?? '?'
        const fallback = !!adapter.isFallbackAdapter
        p.adapterSummary = `name=${name} fallback=${fallback}`
      }
    } catch (e) {
      p.hasAdapter = false
      p.reason = `requestAdapter 异常：${e instanceof Error ? e.message : String(e)}`
    }
    if (p.hasAdapter) {
      try {
        const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
        const adapter: any = await gpu?.requestAdapter()
        const dev = await adapter?.requestDevice?.()
        p.hasDevice = !!dev
      } catch {
        p.hasDevice = false
      }
    }
    p.backend = p.hasDevice && !p.reason ? 'webgpu' : 'webgl2'
    cachedProbe = p
  })()
  return result
}

/** 给用户提供一条 WebGPU 状态摘要，用于 UI 展示。 */
export function describeWebGpuStatus(): string {
  if (typeof window === 'undefined') return '服务端环境'
  const p = probeWebGPU()
  const lines: string[] = [
    `安全上下文: ${p.isSecureContext ? '✅' : '❌'} (${p.origin})`,
    `navigator.gpu: ${p.hasGpu ? '✅ 存在' : '❌ 缺失'}`,
  ]
  if (!p.hasGpu) {
    lines.push('根因:', p.reason || '')
  }
  if (p.hasAdapter) {
    lines.push(`适配器: ✅ ${p.adapterSummary ?? ''}`)
  } else if (p.hasGpu) {
    lines.push('适配器: ❌ requestAdapter 失败')
  }
  lines.push(`生效后端: ${p.backend}`)
  if (p.reason) lines.push(`原因: ${p.reason}`)
  return lines.join(' | ')
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
  const hasGpu = !!(navigator as unknown as { gpu?: unknown }).gpu
  const isSecure = typeof window !== 'undefined' ? window.isSecureContext : false
  const origin = typeof location !== 'undefined' ? location.origin : '?'
  console.warn(
    `[particle] 开始探测 WebGPU ｜` +
      `navigator.gpu=${hasGpu ? '存在' : '缺失'} ` +
      `isSecureContext=${isSecure} origin=${origin} preference=${preference}`,
  )

  let webgpuOk = false
  let reason = ''
  if (preference !== 'webgl2') {
    // preference=webgpu 时：不探测，直接尝试（失败后降级，log 里能看到具体错误）
    // preference=auto 时：先探测再决定
    if (preference === 'webgpu') {
      console.warn('[particle] 强制使用 WebGPU，跳过探测，尝试初始化…')
      webgpuOk = true
    } else {
      webgpuOk = await supportsWebGPU()
      if (!webgpuOk) {
        console.warn(`[particle] WebGPU 探测失败 → 降级到 WebGL 2.0 ｜${reason || '不支持'}`)
      }
    }
  } else {
    console.warn('[particle] 已指定 preference=webgl2，跳过 WebGPU 探测')
  }

  if (webgpuOk) {
    try {
      const renderer = await createWebGPURenderer(options)
      onBackendResolved?.(renderer.backend)
      console.warn(`[particle] WebGPU 渲染器就绪 backend=${renderer.backend}`)
      return renderer
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[particle] WebGPU 初始化失败，降级到 WebGL 2.0：${msg}`)
    }
  }

  if (supportsWebGL2()) {
    const renderer = createWebGL2Renderer(options)
    onBackendResolved?.(renderer.backend)
    console.warn(`[particle] 使用 WebGL 2.0 后端 backend=${renderer.backend}`)
    return renderer
  }

  throw new ParticleBackendUnavailableError(
    '当前环境不支持 WebGPU 或 WebGL 2.0，无法渲染粒子界面',
  )
}

/** WebGPU 探测：navigator.gpu 存在且能拿到 adapter + device。 */
async function supportsWebGPU(): Promise<boolean> {
  const hasGpu = !!(navigator as unknown as { gpu?: unknown }).gpu
  if (!hasGpu) {
    const err = !window?.isSecureContext
      ? `非安全上下文（${location?.origin}）→ 浏览器隐藏 navigator.gpu`
      : 'navigator.gpu 缺失'
    console.warn(`[particle] WebGPU 不可用：${err}`)
    return false
  }
  try {
    const gpu = (navigator as any).gpu
    if (!gpu) return false
    const adapter: any = await gpu.requestAdapter()
    if (!adapter) {
      console.warn('[particle] WebGPU 不可用：requestAdapter 返回空')
      return false
    }
    const dev = await adapter.requestDevice?.()
    if (!dev) {
      console.warn('[particle] WebGPU 不可用：requestDevice 返回空')
      return false
    }
    console.warn('[particle] WebGPU 探测通过')
    return true
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.warn(`[particle] WebGPU 不可用：requestAdapter/requestDevice 抛异常：${msg}`)
    return false
  }
}
