/**
 * 终端类型识别。
 *
 * 粒子界面需要根据终端切换交互方式：
 *   - PC 浏览器：Maya 风格键鼠组合（Alt+中键旋转 / Alt+右键推拉 / 中键平移）
 *   - iOS / iPad：多指手势（单指旋转 / 双指平移 / 三指推拉）
 *
 * 判定不能只看 UA：iPadOS 13+ 的 Safari 默认以 "Macintosh" 上报 UA，
 * 必须结合触摸能力（maxTouchPoints）才能正确识别。
 */

export type DeviceKind = 'pc' | 'ios' | 'android' | 'unknown'

/** 触摸能力：iPadOS 伪装成 Macintosh 时，这是唯一的可靠判据。 */
function hasTouch(): boolean {
  if (typeof window === 'undefined') return false
  return (
    'ontouchstart' in window ||
    (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1)
  )
}

/**
 * 识别当前终端类型。
 * 结果在模块内缓存：UA 与触摸能力在一次会话内不会变化，避免每帧重复计算。
 */
let cached: DeviceKind | null = null

export function detectDeviceKind(): DeviceKind {
  if (cached) return cached
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return 'unknown'

  const ua = navigator.userAgent || ''
  const touch = hasTouch()

  // iPadOS 13+：UA 含 Macintosh，但具备多点触摸 → 判为 iOS 系
  const isIOSUA = /iPad|iPhone|iPod/.test(ua)
  const isIPadOSMasquerading = /Macintosh/.test(ua) && touch

  if (isIOSUA || isIPadOSMasquerading) {
    cached = 'ios'
  } else if (/Android/.test(ua)) {
    cached = 'android'
  } else if (touch) {
    // 其它触摸设备（安卓平板 / 触摸本）按移动端语义处理
    cached = 'android'
  } else {
    cached = 'pc'
  }
  return cached
}

/** 是否为移动端语义（iOS / iPad / Android 等触摸优先设备）。 */
export function isMobileLike(): boolean {
  const k = detectDeviceKind()
  return k === 'ios' || k === 'android'
}

/** 是否为 PC 浏览器（键鼠）。 */
export function isPC(): boolean {
  return detectDeviceKind() === 'pc'
}

/**
 * 设备像素比上限。
 * 移动端 GPU 较弱，限制 DPR 可显著降低填充率压力。
 */
export function suggestedPixelRatio(max = 2): number {
  if (typeof window === 'undefined') return 1
  const dpr = window.devicePixelRatio || 1
  return Math.min(dpr, isMobileLike() ? 1.5 : max)
}

/**
 * 建议的粒子网格边长（grid×grid 个粒子）。
 * 移动端自动降级，避免低端设备掉帧。
 */
export function suggestedGrid(base: number): number {
  if (!isMobileLike()) return base
  // 移动端降到约 60% 的边长（粒子数约为 36%）
  return Math.max(48, Math.round(base * 0.6))
}
