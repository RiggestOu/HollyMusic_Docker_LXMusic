/**
 * 骷髅点云资源加载 —— 格式按 Mineradio 的 `loadSkullParticleAsset` 对齐。
 *
 * 二进制格式（**已核实**，不要凭猜测改）：
 *   · 整份文件就是一个裸的 `Float32Array`
 *   · 长度必须是 20 字节的整数倍（其校验：`byteLength % 20 !== 0` 直接抛错）
 *   · 每个点 **5 个 float**：`[x, y, z, kind, seed]`
 *       - x/y/z  → 点坐标
 *       - kind   → 点类别（其用于区分牙齿/表面等部位，做不同的亮度与幅度）
 *       - seed   → 每点随机相位（0..1）
 *   本项目文件：`public/assets/skull-decimation-points.bin`，1,048,320 字节 → 52,416 个点
 */

export interface SkullPointCloud {
  /** 点坐标，长度 = count * 3 */
  readonly positions: Float32Array
  /** 每点类别，长度 = count */
  readonly kinds: Float32Array
  /** 每点相位种子（0..1），长度 = count */
  readonly seeds: Float32Array
  readonly count: number
}

const ASSET_URL = '/assets/skull-decimation-points.bin'

const cache: { promise: Promise<SkullPointCloud | null> | null; data: SkullPointCloud | null; failed: boolean } = {
  promise: null,
  data: null,
  failed: false,
}

/**
 * 加载骷髅点云（全局只加载一次，失败后被记住，不再重复请求）。
 * 任何异常都返回 null —— 调用方应保持当前占位表现，不报错打断播放。
 */
export function loadSkullPointCloud(): Promise<SkullPointCloud | null> {
  if (cache.data) return Promise.resolve(cache.data)
  if (cache.failed) return Promise.resolve(null)
  if (cache.promise) return cache.promise
  if (typeof fetch !== 'function') {
    cache.failed = true
    return Promise.resolve(null)
  }

  cache.promise = fetch(ASSET_URL)
    .then(res => {
      if (!res.ok) throw new Error('skull asset ' + res.status)
      return res.arrayBuffer()
    })
    .then(buf => {
      // 与它一致的合法性校验：长度必须是 20 字节的整数倍
      if (!buf || buf.byteLength < 20 || buf.byteLength % 20 !== 0) {
        throw new Error('invalid skull asset: ' + (buf ? buf.byteLength : 'empty'))
      }
      const points = new Float32Array(buf)
      const count = Math.floor(points.length / 5)
      const positions = new Float32Array(count * 3)
      const kinds = new Float32Array(count)
      const seeds = new Float32Array(count)
      for (let i = 0; i < count; i++) {
        positions[i * 3] = points[i * 5]
        positions[i * 3 + 1] = points[i * 5 + 1]
        positions[i * 3 + 2] = points[i * 5 + 2]
        kinds[i] = points[i * 5 + 3]
        seeds[i] = points[i * 5 + 4]
      }
      cache.data = { positions, kinds, seeds, count }
      cache.promise = null
      return cache.data
    })
    .catch(err => {
      console.warn('[particle] 骷髅点云加载失败，保持占位表现：', err)
      cache.failed = true
      cache.promise = null
      return null
    })

  return cache.promise
}

/**
 * 把点云抽稀到指定数量（均匀取点，保持整体形状）。
 *
 * 我们的粒子缓冲是固定大小（网格² + 星河），点云往往比它多，必须抽稀后复用现有粒子槽位。
 */
export function resampleSkull(
  cloud: SkullPointCloud,
  target: number,
): { positions: Float32Array; seeds: Float32Array } | null {
  if (!cloud || cloud.count === 0 || target <= 0) return null
  const n = Math.min(target, cloud.count)
  // 均匀步长：保证抽稀后仍是整体轮廓而不是只取到前一段
  const step = cloud.count / n
  const positions = new Float32Array(target * 3)
  const seeds = new Float32Array(target)
  for (let i = 0; i < target; i++) {
    // 超出部分回到点云起点循环取，避免尾部空缺
    const src = Math.floor((i % n) * step)
    positions[i * 3] = cloud.positions[src * 3]
    positions[i * 3 + 1] = cloud.positions[src * 3 + 1]
    positions[i * 3 + 2] = cloud.positions[src * 3 + 2]
    seeds[i] = cloud.seeds[src]
  }
  return { positions, seeds }
}
