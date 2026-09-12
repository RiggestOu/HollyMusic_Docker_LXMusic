export function rendererSend(name: string, params?: any): void {
  window.electron?.[name]?.(params)
}
