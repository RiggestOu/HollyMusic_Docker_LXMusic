/**
 * 封面深度 / 边缘纹理生成 —— 移植 Mineradio 的分析管线（启发式版本）。
 *
 * Mineradio 的 `buildEdgeAndDepth` 是**纯数学**的（不需要任何模型或服务）：
 *   1) 归一化到 256×256 并取亮度  lum = 0.299R + 0.587G + 0.114B
 *   2) 盒式模糊 ×2（水平 + 垂直，半径 4）——作为深度与边缘的基底，用于降噪
 *   3) Sobel 求梯度  edge = min(1, |g| * 1.4)（在模糊图上做，减少噪声）
 *   4) 启发式深度    depth = min(1, bright*0.45 + centerBias*0.55)
 *   5) 前景掩码      fg = min(1, depth*0.6 + edge*0.5)
 *   6) 打包成 256×256 RGBA：R=depth G=edge B=fg A=lum
 *
 * 之所以要「对齐到 Mineradio」而不是自己拍脑袋：它的着色器里 depthZ 与 edgeBoost
 * 的系数就是按这套数值调的（例如预设 0 的
 * `depthZ = (depthVal - 0.5) * uAiBoost * uDepth * 1.40`），
 * 换一套深度算法会让浮雕强度和发光边都失准。
 *
 * 另有可选的 AI 深度增强（Xenova/depth-anything-small，走 CDN 动态加载），
 * 失败时回退到本文件的启发式结果 —— 与其行为一致。
 */

/** 纹理边长，与其保持一致（着色器里 edge.r/g/b/a 的取值依赖这个尺寸做 neighbour 采样无关，但缓存与上传按 256 固定）。 */
export const COVER_EDGE_SIZE = 256

/**
 * 由封面画布生成深度 / 边缘纹理。
 *
 * @param cover 已按「cover 语义」裁好的方形封面画布（任意尺寸，内部会缩放到 256）
 * @returns 256×256 的 RGBA 画布（R=depth G=edge B=fg A=lum）；输入无效时返回 null
 */
export function buildCoverEdgeDepth(cover: HTMLCanvasElement | null): HTMLCanvasElement | null {
  if (!cover || typeof document === 'undefined') return null
  const W = COVER_EDGE_SIZE
  const H = COVER_EDGE_SIZE
  const N = W * H

  const norm = document.createElement('canvas')
  norm.width = W
  norm.height = H
  const sctx = norm.getContext('2d')
  if (!sctx) return null
  sctx.drawImage(cover, 0, 0, W, H)
  const src = sctx.getImageData(0, 0, W, H).data

  const lum = new Float32Array(N)
  const blur = new Float32Array(N)
  const tmp = new Float32Array(N)

  // 1) 亮度
  for (let i = 0; i < N; i++) {
    const di = i * 4
    lum[i] = (src[di] * 0.299 + src[di + 1] * 0.587 + src[di + 2] * 0.114) / 255
  }

  // 2) 盒式模糊 ×2（滑动窗口实现，O(N)）
  const blurH = (s: Float32Array, d: Float32Array, r: number) => {
    for (let y = 0; y < H; y++) {
      let sum = 0
      for (let x = -r; x <= r; x++) sum += s[y * W + Math.max(0, Math.min(W - 1, x))]
      for (let x = 0; x < W; x++) {
        d[y * W + x] = sum / (2 * r + 1)
        const xR = Math.min(W - 1, x + r + 1)
        const xL = Math.max(0, x - r)
        sum += s[y * W + xR] - s[y * W + xL]
      }
    }
  }
  const blurV = (s: Float32Array, d: Float32Array, r: number) => {
    for (let x = 0; x < W; x++) {
      let sum = 0
      for (let y = -r; y <= r; y++) sum += s[Math.max(0, Math.min(H - 1, y)) * W + x]
      for (let y = 0; y < H; y++) {
        d[y * W + x] = sum / (2 * r + 1)
        const yD = Math.min(H - 1, y + r + 1)
        const yU = Math.max(0, y - r)
        sum += s[yD * W + x] - s[yU * W + x]
      }
    }
  }
  blurH(lum, tmp, 4)
  blurV(tmp, blur, 4)

  // 3) Sobel 边缘（在模糊图上做）
  const edge = new Float32Array(N)
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const gx =
        -blur[(y - 1) * W + (x - 1)] -
        2 * blur[y * W + (x - 1)] -
        blur[(y + 1) * W + (x - 1)] +
        blur[(y - 1) * W + (x + 1)] +
        2 * blur[y * W + (x + 1)] +
        blur[(y + 1) * W + (x + 1)]
      const gy =
        -blur[(y - 1) * W + (x - 1)] -
        2 * blur[(y - 1) * W + x] -
        blur[(y - 1) * W + (x + 1)] +
        blur[(y + 1) * W + (x - 1)] +
        2 * blur[(y + 1) * W + x] +
        blur[(y + 1) * W + (x + 1)]
      edge[y * W + x] = Math.min(1.0, Math.sqrt(gx * gx + gy * gy) * 1.4)
    }
  }

  // 4) 启发式深度：亮度 + 中心偏置
  const depth = new Float32Array(N)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      const cx = (x / (W - 1) - 0.5) * 2.0
      const cy = (y / (H - 1) - 0.5) * 2.0
      const rr = Math.sqrt(cx * cx + cy * cy)
      const centerBias = 1.0 - Math.min(1, rr * 0.75)
      depth[i] = Math.min(1.0, blur[i] * 0.45 + centerBias * 0.55)
    }
  }

  // 5) 打包输出
  const out = document.createElement('canvas')
  out.width = W
  out.height = H
  const octx = out.getContext('2d')
  if (!octx) return null
  const imgOut = octx.createImageData(W, H)
  for (let i = 0; i < N; i++) {
    const di = i * 4
    imgOut.data[di] = Math.round(depth[i] * 255)
    imgOut.data[di + 1] = Math.round(edge[i] * 255)
    imgOut.data[di + 2] = Math.round(Math.min(1.0, depth[i] * 0.6 + edge[i] * 0.5) * 255)
    imgOut.data[di + 3] = Math.round(lum[i] * 255)
  }
  octx.putImageData(imgOut, 0, 0)
  return out
}
