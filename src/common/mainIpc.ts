import { ipcMain } from 'electron'

export function mainOn(name: string, listener: any): void {
  ipcMain.on(name, (event: any, params: any) => {
    listener({ event, params })
  })
}

export function mainSend(window: Electron.BrowserWindow, name: string, params?: any): void {
  window.webContents.send(name, params)
}
