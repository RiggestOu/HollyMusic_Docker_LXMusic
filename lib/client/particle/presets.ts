/**
 * 粒子预设表 —— 两条渲染后端与 UI 共用的唯一事实来源。
 *
 * 索引必须与着色器里的 `presetTarget()` / `presetTint()` 分支逐项对应：
 * 顺序错一位就会让菜单上的名字和实际画面不符，而且不会有任何编译错误。
 * 因此这里集中定义，UI 只按数组顺序渲染，着色器只按索引分支。
 *
 * 名称参考 Mineradio 的 13 个视觉预设（GPL-3.0），
 * 但几何与配色均为本项目独立实现，未复制其源码。
 */

export interface ParticlePreset {
  /** 着色器分支索引，等同数组下标。 */
  readonly id: number
  /** 稳定标识（用于持久化）。 */
  readonly key: string
  /** 菜单显示名。 */
  readonly label: string
  /** 一句话说明，作为菜单项的 title 提示。 */
  readonly hint: string
}

export const PRESETS: readonly ParticlePreset[] = [
  { id: 0, key: 'silk', label: '专辑封面', hint: '把当前歌曲封面转成粒子拼出专辑图' },
  { id: 1, key: 'tunnel', label: '滚筒', hint: '绕轴旋转的筒壁，低频让筒径呼吸' },
  { id: 2, key: 'orbit', label: '星球', hint: '带扁率的球体，缓慢自转' },
  { id: 3, key: 'void', label: '虚空', hint: '大尺度稀疏壳层，极慢漂移' },
  { id: 4, key: 'vinyl', label: '唱片', hint: '旋转的黑胶唱片盘面' },
  { id: 5, key: 'pulse', label: '音域回响', hint: '垂幕极光带（槽位 5/7/8 共用同一套实现）' },
  { id: 6, key: 'skull', label: '骷髅点云', hint: '浮空点云字形（Mineradio 用外部点云资源，此处为程序化等价实现）' },
  { id: 7, key: 'pulse-7', label: '音域回响', hint: '与槽位 5 同一套实现（Mineradio 这三个槽位共用代码）' },
  { id: 8, key: 'pulse-8', label: '音域回响', hint: '与槽位 5 同一套实现（Mineradio 这三个槽位共用代码）' },
  { id: 9, key: 'eclipse', label: '月蚀圣杯', hint: '细环光晕，环径随低频呼吸' },
  { id: 10, key: 'drizzle', label: '雨幕霓虹', hint: '下落雨幕，纵向循环回绕' },
  { id: 11, key: 'flock', label: '折光蝶群', hint: '分群游动，群体中心走噪声流场' },
  { id: 12, key: 'bloom', label: '深海绽放', hint: '花瓣放射，低频时盛开' },
] as const

/** 预设总数（着色器里的上界，用于取模与夹紧）。 */
export const PRESET_COUNT = PRESETS.length

/** 把任意输入夹到合法预设索引。 */
export function clampPreset(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(PRESET_COUNT - 1, Math.max(0, Math.round(value)))
}

/** 按稳定 key 查找索引；找不到返回 0（专辑封面）。 */
export function presetIndexByKey(key: string | null | undefined): number {
  if (!key) return 0
  const found = PRESETS.findIndex(p => p.key === key)
  return found >= 0 ? found : 0
}

/**
 * 预设的本地持久化键。
 *
 * 用 localStorage 而不是 Tauri 配置：主窗口与壁纸窗口同源（都加载同一个前端），
 * 因此 localStorage 天然共享 —— 壁纸窗口无需改 Rust 侧配置结构即可套用同一预设。
 */
const PRESET_STORAGE_KEY = 'particle:preset'

/** 读取本地记住的预设；无记录或环境不支持时返回 0。 */
export function loadStoredPreset(): number {
  if (typeof window === 'undefined') return 0
  try {
    const raw = window.localStorage.getItem(PRESET_STORAGE_KEY)
    if (raw === null) return 0
    return clampPreset(Number(raw))
  } catch {
    return 0
  }
}

/** 写入本地预设（失败静默：隐私模式下 localStorage 可能抛错，不该影响渲染）。 */
export function storePreset(index: number): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(PRESET_STORAGE_KEY, String(clampPreset(index)))
  } catch {
    /* 忽略：持久化失败不影响本次会话 */
  }
}

/** 预设变化事件名：同一标签页内广播用（storage 事件只在其它标签页/窗口触发）。 */
export const PRESET_CHANGED_EVENT = 'particle-preset-changed'

/** 供壁纸窗口跨窗口同步：监听 localStorage 的 storage 变化 + 同页自定义事件。 */
export function subscribePresetChange(handler: (preset: number) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const onStorage = (e: StorageEvent) => {
    if (e.key !== null && e.key !== PRESET_STORAGE_KEY) return
    handler(loadStoredPreset())
  }
  const onLocal = () => handler(loadStoredPreset())
  window.addEventListener('storage', onStorage)
  window.addEventListener(PRESET_CHANGED_EVENT, onLocal)
  return () => {
    window.removeEventListener('storage', onStorage)
    window.removeEventListener(PRESET_CHANGED_EVENT, onLocal)
  }
}

