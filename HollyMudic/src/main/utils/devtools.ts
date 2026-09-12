import { log } from './log'

export const openDevTools = (webContents: Electron.WebContents) => {
  webContents.openDevTools()
}

export const closeDevTools = (webContents: Electron.WebContents) => {
  webContents.closeDevTools()
}
