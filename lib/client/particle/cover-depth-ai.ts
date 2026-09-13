/**
 * 可选 AI 深度增强 —— 对齐 Mineradio 的做法：运行时动态加载 Xenova transformers，
 * 用 depth-anything-small 估计真实深度，失败/未开启时回退到启发式结果。
 *
 * 设计要点（照搬其策略，避免自己拍脑袋）：
 *   · **默认关闭**：其由 fx.aiDepth 控制，本项目用 localStorage 开关，默认 false。
 *   · **动态 import CDN**：不进打包产物，不用的人才付那 50MB 流量。
 *     https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2
 *   · **失败静默**：任何异常都返回 null，调用方沿用启发式深度，界面无感。
 *   · **结果只替换 R 通道**：G(edge) / B(fg) / A(lum) 仍来自启发式管线，
 *     与它「AI 只增强 depth」的处理一致。
 *
 * 注意：需要网络可访问 jsdelivr；离线或内网部署时不会有任何影响（静默跳过）。
 */

/** AI 深度开关的存储键。 */
const AI_DEPTH_KEY = 'particle:aiDepth'

/** CDN 与模型（与其保持一致，便于行为对齐）。 */
const TRANSFORMERS_CDN = 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2'
const DEPTH_MODEL = 'Xenova/depth-anything-small-hf'

type PipelineLike = (input: unknown, options?: unknown) => Promise<{ depth: { toCanvas: () => HTMLCanvasElement } }>

let pipelinePromise: Promise<PipelineLike | null> | null = null

/** 读取开关（默认关闭）。 */
export function loadAiDepthEnabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(AI_DEPTH_KEY) === '1'
  } catch {
    return false
  }
}

/** 写入开关。 */
export function setAiDepthEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(AI_DEPTH_KEY, enabled ? '1' : '0')
  } catch {
    /* 隐私模式下忽略 */
  }
}

/** 懒加载管线：只加载一次，失败后被记住（不再重复下载）。 */
function ensurePipeline(): Promise<PipelineLike | null> {
  if (pipelinePromise) return pipelinePromise
  pipelinePromise = (async () => {
    try {
      // 动态 import 外部 URL：加 vite-ignore 避免构建期解析
      const mod = (await import(/* @vite-ignore */ TRANSFORMERS_CDN)) as {
        env?: { backends?: { onnx?: { wasm?: { numThreads?: number } } } }
        pipeline?: (task: string, model: string) => Promise<PipelineLike>
      }
      // 单线程，避免与音频/渲染争抢
      if (mod.env?.backends?.onnx?.wasm) mod.env.backends.onnx.wasm.numThreads = 1
      if (!mod.pipeline) return null
      return (await mod.pipeline('depth-estimation', DEPTH_MODEL)) as PipelineLike
    } catch (err) {
      console.warn('[particle] AI 深度模型加载失败，回退启发式深度：', err)
      return null
    }
  })()
  return pipelinePromise
}

/**
 * 用 AI 深度替换给定深度/边缘图的 R 通道。
 *
 * @param cover 封面画布
 * @param base 已由 buildCoverEdgeDepth 生成的 256×256 图（提供 G/B/A 通道）
 * @returns 新的 256×256 画布；未开启、失败或已取消时返回 null
 */
export async function enhanceCoverDepth(
  cover: HTMLCanvasElement,
  base: HTMLCanvasElement,
): Promise<HTMLCanvasElement | null> {
  if (!loadAiDepthEnabled()) return null
  if (typeof document === 'undefined') return null

  const pipe = await ensurePipeline()
  if (!pipe) return null

  try {
    const result = await pipe(cover, {})
    const depthCanvas = result?.depth?.toCanvas?.()
    if (!depthCanvas) return null

    const size = 256
    const out = document.createElement('canvas')
    out.width = size
    out.height = size
    const ctx = out.getContext('2d')
    if (!ctx) return null

    // 先把 AI 深度画进去（取灰度 → 放到 R）
    ctx.drawImage(depthCanvas, 0, 0, size, size)
    const ai = ctx.getImageData(0, 0, size, size)
    const srcCtx = base.getContext('2d')
    const src = srcCtx ? srcCtx.getImageData(0, 0, size, size) : null

    for (let i = 0; i < ai.data.length; i += 4) {
      const d = (ai.data[i] * 0.299 + ai.data[i + 1] * 0.587 + ai.data[i + 2] * 0.114) / 255
      ai.data[i] = Math.round(d * 255) // R = AI 深度
      if (src) {
        ai.data[i + 1] = src.data[i + 1] // G = edge（沿用启发式）
        ai.data[i + 2] = src.data[i + 2] // B = fg
        ai.data[i + 3] = src.data[i + 3] // A = lum
      } else {
        ai.data[i + 3] = 255
      }
    }
    ctx.putImageData(ai, 0, 0)
    return out
  } catch (err) {
    console.warn('[particle] AI 深度估计失败，回退启发式深度：', err)
    return null
  }
}
