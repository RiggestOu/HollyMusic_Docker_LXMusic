/**
 * 粒子预设表 —— 两条渲染后端与 UI 共用的唯一事实来源。
 *
 * 索引必须与着色器里的  /  分支逐项对应：
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
  { id: 0, key: "silk", label: "专辑封面", hint: "把当前歌曲封面转成粒子拼出专辑图" },
  { id: 1, key: "tunnel", label: "滚筒", hint: "绕轴旋转的筒壁，低频让筒径呼吸" },
  { id: 2, key: "orbit", label: "星球", hint: "带扁率的球体，缓慢自转" },
  { id: 3, key: "void", label: "虚空", hint: "大尺度稀疏壳层，极慢漂移" },
  { id: 4, key: "vinyl", label: "唱片", hint: "旋转的黑胶唱片盘面" },
  { id: 5, key: "star_river", label: "星河", hint: "壁纸粒子 · 音乐律动" },
  { id: 6, key: "skull", label: "安魂", hint: "浮空点云字形（Mineradio 用外部点云资源，此处为程序化等价实现）" },
  { id: 7, key: "pulse", label: "音域回响", hint: "垂幕极光带（Mineradio 作者 Ajin，Sonic-Topography）" },
  { id: 8, key: "pulse-8", label: "音域回响", hint: "垂幕极光带（Mineradio 作者 CmzYa，Wallpaper Engine）" },
  { id: 9, key: "eclipse", label: "月蚀圣环", hint: "细环光晕，环径随低频呼吸" },
  { id: 10, key: "drizzle", label: "雨幕霓虹", hint: "下落雨幕，纵向循环回绕" },
  { id: 11, key: "flock", label: "折光蝶群", hint: "分群游动，群体中心走噪声流场" },
  { id: 12, key: "bloom", label: "深海绽放", hint: "花瓣放射，低频时盛开" },
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

// ---- 相机状态持久化 ----

/** 单个预设的相机位置（球坐标 + 目标点）。 */
export interface CameraState {
  /** 偏角（绕 Y 轴旋转，弧度） */
  theta: number
  /** 极角（自 +Y 轴量起，弧度） */
  phi: number
  /** 距离 */
  radius: number
  /** 目标点 [x, y, z] */
  target: [number, number, number]
}

/** 所有预设的相机状态快照（key → state）。 */
const CAMERA_STORAGE_KEY = "particle:cameras"

/**
 * 读取指定预设的相机位置。
 * 无记录时返回 undefined，调用方用基线补全。
 */
export function loadCameraState(presetIndex: number): CameraState | undefined {
  if (typeof window === "undefined") return undefined
  try {
    const raw = window.localStorage.getItem(CAMERA_STORAGE_KEY)
    if (raw === null) return undefined
    const map = JSON.parse(raw) as Record<number, Partial<CameraState>> | null
    if (!map || typeof map !== "object") return undefined
    const partial = map[presetIndex]
    if (!partial || typeof partial !== "object") return undefined
    // 必须至少有 theta 或 phi 其中之一才算有效记录
    if (typeof partial.theta !== "number" && typeof partial.phi !== "number") return undefined
    return {
      theta: typeof partial.theta === "number" ? partial.theta : 0,
      phi: typeof partial.phi === "number" ? partial.phi : 0,
      radius: typeof partial.radius === "number" ? partial.radius : 6.6,
      target: Array.isArray(partial.target)
        ? [
            typeof partial.target[0] === "number" ? partial.target[0] : 0,
            typeof partial.target[1] === "number" ? partial.target[1] : 0,
            typeof partial.target[2] === "number" ? partial.target[2] : 0,
          ]
        : [0, 0, 0],
    }
  } catch {
    return undefined
  }
}

/**
 * 保存指定预设的相机位置（失败静默）。
 */
export function storeCameraState(presetIndex: number, state: CameraState): void {
  if (typeof window === "undefined") return
  try {
    const raw = window.localStorage.getItem(CAMERA_STORAGE_KEY)
    let map: Record<number, Partial<CameraState>> = {}
    if (raw) {
      try { map = JSON.parse(raw) as Record<number, Partial<CameraState>> } catch { /* ignore */ }
    }
    if (!map || typeof map !== "object") map = {}
    map[presetIndex] = { ...map[presetIndex], ...state }
    window.localStorage.setItem(CAMERA_STORAGE_KEY, JSON.stringify(map))
  } catch {
    /* 忽略：持久化失败不影响本次会话 */
  }
}

/**
 * 恢复指定预设的相机位置：优先用 localStorage 记录，
 * 其次用默认基线（PRESET_CAMERA）。调用方传完整初始 rig，本函数原地修改 rig 字段。
 */
export function applyCameraState(
  presetIndex: number,
  rig: { theta: number; phi: number; radius: number; target: [number, number, number] },
  base: { theta: number; phi: number; radius: number },
): void {
  const saved = loadCameraState(presetIndex)
  if (saved) {
    rig.theta = saved.theta
    rig.phi = saved.phi
    rig.radius = saved.radius
    rig.target = saved.target
  } else {
    rig.theta = base.theta
    rig.phi = base.phi
    rig.radius = base.radius
    rig.target = [0, 0, 0]
  }
}

/**
 * 预设的本地持久化键。
 *
 * 用 localStorage 而不是 Tauri 配置：主窗口与壁纸窗口同源（都加载同一个前端），
 * 因此 localStorage 天然共享 —— 壁纸窗口无需改 Rust 侧配置结构即可套用同一预设。
 */
const PRESET_STORAGE_KEY = "particle:preset"

/** 读取本地记住的预设；无记录或环境不支持时返回 0。 */
export function loadStoredPreset(): number {
  if (typeof window === "undefined") return 0
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
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(PRESET_STORAGE_KEY, String(clampPreset(index)))
  } catch {
    /* 忽略：持久化失败不影响本次会话 */
  }
}

/** 预设变化事件名：同一标签页内广播用（storage 事件只在其它标签页/窗口触发）。 */
export const PRESET_CHANGED_EVENT = "particle-preset-changed"

/** 供壁纸窗口跨窗口同步：监听 localStorage 的 storage 变化 + 同页自定义事件。 */
export function subscribePresetChange(handler: (preset: number) => void): () => void {
  if (typeof window === "undefined") return () => {}
  const onStorage = (e: StorageEvent) => {
    if (e.key !== null && e.key !== PRESET_STORAGE_KEY) return
    handler(loadStoredPreset())
  }
  const onLocal = () => handler(loadStoredPreset())
  window.addEventListener("storage", onStorage)
  window.addEventListener(PRESET_CHANGED_EVENT, onLocal)
  return () => {
    window.removeEventListener("storage", onStorage)
    window.removeEventListener("storage", onLocal)
  }
}
