import { ipcRenderer } from 'electron'

export function rendererSend(name: string, params?: any): void {
  ipcRenderer.send(name, params)
}

export async function rendererInvoke<T>(name: string, params?: any): Promise<T> {
  return ipcRenderer.invoke(name, params)
}

export function rendererOn(name: string, listener: LX.IpcRendererEventListener): void {
  ipcRenderer.on(name, (event, params) => {
    listener({ event, params })
  })
}
