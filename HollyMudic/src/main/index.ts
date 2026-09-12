import { app, BrowserWindow } from 'electron'
import path from 'path'
import { fileURLToPath } from 'url'
import { registerSourceHandlers } from './ipc/source'
import { initGlobalData, initSingleInstanceHandle, applyElectronEnvParams, setUserDataPath } from './app'
import { isLinux } from '@common/utils'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let mainWindow: BrowserWindow | null = null

function createMainWindow() {
  mainWindow = new BrowserWindow({
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

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:3080')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// 初始化应用
const init = () => {
  initGlobalData()
  initSingleInstanceHandle()
  applyElectronEnvParams()
  setUserDataPath()
  
  registerSourceHandlers()
  
  // 创建主窗口
  createMainWindow()
  
  if (isLinux) {
    setTimeout(() => {
      global.lx.event_app.app_inited()
    }, 300)
  } else {
    global.lx.event_app.app_inited()
  }
}

app.whenReady().then(() => {
  init()
  
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      init()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

export { mainWindow }
