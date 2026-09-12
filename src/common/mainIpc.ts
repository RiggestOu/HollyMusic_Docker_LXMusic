import { ipcMain } from 'electron'

export function mainOn(name: string, listener: LX.IpcMainEventListener): void
export function mainOn<T>(name: string, listener: LX.IpcMainEventListenerParams<T>): void
export function mainOn<T>(name: string, listener: LX.IpcMainEventListenerParams<T>): void {
  ipcMain.on(name, (event, params) => {
    listener({ event, params })
  })
}

export function mainSend(window: Electron.BrowserWindow, name: string, params?: any): void {
  window.webContents.send(name, params)
}

export function mainHandle<T, V>(name: string, listener: LX.IpcMainInvokeEventListenerParamsValue<T, V>): void {
  ipcMain.handle(name, async (event, params) => {
    return listener({ event, params })
  })
}
