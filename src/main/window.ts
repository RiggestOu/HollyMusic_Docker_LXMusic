import { app, BrowserWindow } from 'electron'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 创建主窗口
export function createMainWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    transparent: process.env.NODE_ENV !== 'production',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  })

  // 加载页面
  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:3080')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../renderer/index.html'))
  }

  return mainWindow
}

// 创建源窗口（用于运行自定义音源脚本）
export function createSourceWindow(userApi: LX.UserApi.UserApiInfo): BrowserWindow {
  const sourceWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  })

  sourceWindow.loadURL('data:text/html;charset=UTF-8,' + encodeURIComponent(`
    <!DOCTYPE html>
    <html>
    <head><title>Source Runtime</title></head>
    <body>
      <script>
        const { contextBridge, ipcRenderer } = require('electron')
        contextBridge.exposeInMainWorld('lxSource', {
          postMessage: (msg) => ipcRenderer.send('source-request', msg),
          onMessage: (callback) => {
            ipcRenderer.on('source-response', (_, data) => callback(data))
          }
        })
      </script>
      <script>${userApi.script}</script>
    </body>
    </html>
  `))

  return sourceWindow
}

let mainWindow: BrowserWindow | null = null

export const getMainWindow = () => mainWindow

export const createAppWindows = () => {
  mainWindow = createMainWindow()
  
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

export const quitApp = () => {
  app.quit()
}
