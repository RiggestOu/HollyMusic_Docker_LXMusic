/**
 * 封面纹理管线 —— 把专辑封面转成粒子可采样的方形纹理。
 *
 * # 为什么统一输出固定 256×256 的 canvas
 * 两条渲染后端都需要「一张可直接采样的图」：
 *   · WebGL 2.0 → `THREE.CanvasTexture` 包装它；
 *   · WebGPU   → `queue.copyExternalImageToTexture()` 上传它。
 * 尺寸恒定的好处是纹理对象与 bindGroup 只需创建一次，后续切歌仅覆盖像素内容，
 * 不会出现「重建绑定组时的一帧黑屏」，也让两条后端共享完全相同的源数据。
 *
 * # 为什么走 fetch + createImageBitmap 而不是 <img>
 * 服务端 `/api/cover/<uid>` 在音源侧可能 302 到外域图床。此时 `<img>` 画进 canvas
 * 会把 canvas 标记为 tainted —— 上传到 WebGL/WebGPU 纹理会抛 SecurityError，读回
 * 像素也会抛错。走 `fetch()` 拿 blob 再 `createImageBitmap()`，数据始终是同源的
 * 本地副本，不存在跨域污染；跨域且无 CORS 时 fetch 直接失败，我们退回占位图。
 *
 * # 裁切语义
 * 按 CSS `object-fit: cover` 的方式裁切（短边铺满、长边居中裁掉），
 * 保证粒子拼出的图像不变形；不做锐化/滤镜，原始色彩交给粒子着色器处理。
 *
 * 许可证：本文件为独立实现，未复制 Mineradio（GPL-3.0）源码。
 */

/** 纹理边长（2 的幂，兼容所有 WebGL 实现；256 对粒子成像分辨率已足够）。 */
import { buildCoverEdgeDepth } from './cover-depth'

export const COVER_TEXTURE_SIZE = 256

/** 无封面时的占位底色，与粒子场景背景同色系，避免出现突兀的亮块。 */
const PLACEHOLDER_COLOR = '#12121a'

export interface CoverTexture {
  /** 固定 {@link COVER_TEXTURE_SIZE} 见方的画布，直接作为纹理源。 */
  readonly canvas: HTMLCanvasElement
  /** 平均亮度 0..1（0=纯黑）。极暗封面需要额外提亮粒子，否则图像读不出来。 */
  readonly luminance: number
  /** 是否装载了真实封面（false = 占位图）。 */
  readonly hasImage: boolean
  /**
   * 深度 / 边缘纹理（256×256，R=depth G=edge B=fg A=lum），由 buildCoverEdgeDepth 生成。
   * 用于着色器里的浮雕位移（depthZ）与发光边（edgeBoost）；没有封面时为 null。
   */
  readonly edgeCanvas: HTMLCanvasElement | null
}

function createSquareCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = COVER_TEXTURE_SIZE
  canvas.height = COVER_TEXTURE_SIZE
  return canvas
}

/** 把图像按 cover 语义绘制到方形画布上。 */
function drawCoverFit(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
): void {
  const size = COVER_TEXTURE_SIZE
  ctx.clearRect(0, 0, size, size)
  if (sourceWidth <= 0 || sourceHeight <= 0) return

  // 短边铺满、长边居中裁切（等价 CSS object-fit: cover）
  const scale = Math.max(size / sourceWidth, size / sourceHeight)
  const drawWidth = sourceWidth * scale
  const drawHeight = sourceHeight * scale
  const dx = (size - drawWidth) / 2
  const dy = (size - drawHeight) / 2

  ctx.drawImage(source, dx, dy, drawWidth, drawHeight)
}

/** 平均亮度（Rec.601 加权）；读像素失败（极端环境）时返回中性值。 */
function measureLuminance(ctx: CanvasRenderingContext2D): number {
  try {
    const { data } = ctx.getImageData(0, 0, COVER_TEXTURE_SIZE, COVER_TEXTURE_SIZE)
    let sum = 0
    // 每 4 像素采样一次即可：256×256 全量遍历没必要，且结果差异可忽略
    for (let i = 0; i < data.length; i += 16) {
      sum += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114
    }
    return sum / (data.length / 16) / 255
  } catch {
    return 0.5
  }
}

/**
 * 生成占位封面纹理（纯色）。同时用作初始化时的 1 号纹理，
 * 让渲染后端在真正拿到封面之前也有一条稳定的采样路径。
 */
export function createPlaceholderCover(): CoverTexture {
  const canvas = createSquareCanvas()
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.fillStyle = PLACEHOLDER_COLOR
    ctx.fillRect(0, 0, COVER_TEXTURE_SIZE, COVER_TEXTURE_SIZE)
  }
  return { canvas, luminance: 0, hasImage: false, edgeCanvas: null }
}

/**
 * 拉取并解码一张封面。
 *
 * @param url    `/api/cover/<uid>?v=<cacheKey>`；为空直接返回 null
 * @param signal 用于切歌竞态取消：旧请求在 resolve 后被判定为过期即丢弃
 * @returns 成功返回 CoverTexture；网络失败 / 解码失败 / 被取消返回 null
 */
export async function loadCoverTexture(
  url: string | null | undefined,
  signal?: AbortSignal,
): Promise<CoverTexture | null> {
  if (!url) return null
  if (typeof document === 'undefined') return null

  let bitmap: ImageBitmap | null = null
  try {
    const res = await fetch(url, signal ? { signal } : undefined)
    if (!res.ok) return null
    const blob = await res.blob()
    if (signal?.aborted) return null
    bitmap = await createImageBitmap(blob)
    if (signal?.aborted) return null
  } catch {
    // 网络错误 / 解码失败 / AbortError —— 一律退化为「没有封面」
    return null
  }

  const canvas = createSquareCanvas()
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    bitmap.close()
    return null
  }

  drawCoverFit(ctx, bitmap, bitmap.width, bitmap.height)
  const luminance = measureLuminance(ctx)
  bitmap.close()

  return { canvas, luminance, hasImage: true, edgeCanvas: buildCoverEdgeDepth(canvas) }
}
