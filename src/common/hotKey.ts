export interface HotKeyConfig {
  enable: boolean
  keys: Record<string, { type: string; action: string }>
}

export interface HotKeyState {
  enable: boolean
  config: {
    local: HotKeyConfig
    global: HotKeyConfig
  }
  state: Map<string, any>
}

export const HOTKEY_COMMON = {
  close: { action: 'close' },
  hide_toggle: { action: 'hide_toggle' },
  min: { action: 'min' },
  min_toggle: { action: 'min_toggle' },
} as const
