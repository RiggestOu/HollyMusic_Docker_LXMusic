/**
 * 自定义粒子封面图片的本地记忆与跨窗口同步。
 *
 * 图片本体存在 NAS 服务端（/api/particle-image），这里只记它的访问 URL。
 * 主窗口（粒子设置卡）与桌面壁纸窗口同源，因此共用同一份 localStorage；
 * 变更时广播自定义事件，壁纸窗口据此立即切换。
 */

const KEY = "particle:customImage"
export const CUSTOM_IMAGE_CHANGED_EVENT = "particle-custom-image-changed"

/** 读取自定义图片 URL；未设置返回 null。 */
export function loadStoredCustomImage(): string | null {
  if (typeof window === "undefined") return null
  try {
    return window.localStorage.getItem(KEY)
  } catch {
    return null
  }
}

/** 写入/清除（传 null 清除），并广播变更。 */
export function storeCustomImage(url: string | null): void {
  if (typeof window === "undefined") return
  try {
    if (url) window.localStorage.setItem(KEY, url)
    else window.localStorage.removeItem(KEY)
  } catch {
    /* 隐私模式下忽略 */
  }
  window.dispatchEvent(new Event(CUSTOM_IMAGE_CHANGED_EVENT))
}

/** 监听变更（本窗口自定义事件 + 其它窗口的 storage 事件）。 */
export function subscribeCustomImage(handler: (url: string | null) => void): () => void {
  if (typeof window === "undefined") return () => {}
  const emit = () => handler(loadStoredCustomImage())
  const onStorage = (e: StorageEvent) => {
    if (e.key !== null && e.key !== KEY) return
    emit()
  }
  window.addEventListener("storage", onStorage)
  window.addEventListener(CUSTOM_IMAGE_CHANGED_EVENT, emit)
  return () => {
    window.removeEventListener("storage", onStorage)
    window.removeEventListener(CUSTOM_IMAGE_CHANGED_EVENT, emit)
  }
}
