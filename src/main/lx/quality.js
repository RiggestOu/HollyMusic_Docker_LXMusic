'use strict'

/**
 * 音质协商
 *
 * 各音源对音质的命名不统一，例如同样是「无损 24bit」可能写作：
 *   flac24bit / 24bit / hires / master / atmos
 * 若把请求音质原样丢给音源，音源不认就会拒绝 → 表现就是「一部分歌曲没法播放」。
 *
 * 这里按档位分组归一化，并在音源声明的音质集合内挑选最接近的档位，
 * 返回音源真正认得的那个字符串。
 */

/** 档位从高到低排列，同组内视为等价 */
const QUALITY_TIERS = [
  ['flac24bit', '24bit', 'hi-res', 'hires', 'master', 'atmos', 'flac_24bit', 'lossless24'],
  ['flac', 'lossless', 'ape', 'wav'],
  ['320k', '320', 'hq', 'exhigh'],
  ['192k', '192'],
  ['128k', '128', 'lq', 'standard'],
]

/** 标准档位默认降级顺序（从高到低） */
const DEFAULT_ORDER = ['flac24bit', 'flac', '320k', '192k', '128k']

function canonical(q) {
  const s = String(q || '').trim().toLowerCase()
  if (!s) return ''
  for (const tier of QUALITY_TIERS) {
    if (tier.includes(s)) return tier[0]
  }
  return s
}

function tierIndex(q) {
  const c = canonical(q)
  const i = QUALITY_TIERS.findIndex((t) => t[0] === c)
  return i < 0 ? QUALITY_TIERS.length : i
}

function isLossless(q) {
  return tierIndex(q) <= 1
}

/**
 * 在 supported 中挑选与 requested 最接近的档位
 *
 * @param {string} requested  请求音质，如 'flac24bit'
 * @param {string[]} supported 音源声明支持的音质（可为空 → 原样返回 requested）
 * @returns {string} 应传给音源的音质字符串
 */
function negotiate(requested, supported) {
  const req = String(requested || '320k').trim()
  const list = Array.isArray(supported) ? supported.filter((x) => typeof x === 'string' && x) : []

  // 音源未声明音质：不干预，交给音源自己判断
  if (!list.length) return req

  // 1) 精确命中
  if (list.includes(req)) return req

  // 2) 同档位别命中（flac24bit ↔ 24bit ↔ hires ...）
  const reqTier = canonical(req)
  const sameTier = list.find((x) => canonical(x) === reqTier)
  if (sameTier) return sameTier

  // 3) 逐级降档
  const reqIdx = tierIndex(req)
  for (let i = reqIdx + 1; i < QUALITY_TIERS.length; i++) {
    const hit = list.find((x) => canonical(x) === QUALITY_TIERS[i][0])
    if (hit) return hit
  }

  // 4) 无更低档位则逐级升档
  for (let i = reqIdx - 1; i >= 0; i--) {
    const hit = list.find((x) => canonical(x) === QUALITY_TIERS[i][0])
    if (hit) return hit
  }

  // 5) 兜底：音源列表里排最前的
  return list[0]
}

module.exports = { negotiate, canonical, tierIndex, isLossless, DEFAULT_ORDER, QUALITY_TIERS }
