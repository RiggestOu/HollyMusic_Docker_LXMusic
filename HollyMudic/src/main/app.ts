import { existsSync, mkdirSync } from 'fs'
import { app } from 'electron'
import path from 'path'

export const isLinux = process.platform === 'linux'

export const initGlobalData = () => {
  global.envParams = {
    cmdParams: {},
    deeplink: null,
  }
  
  global.lx = {
    inited: false,
    appSetting: {} as LX.AppSetting,
    event_app: {
      on: () => {},
      off: () => {},
      app_inited: () => {},
    } as any,
  }
}

export const setUserDataPath = () => {
  const userDataPath = app.getPath('userData')
  global.lxDataPath = path.join(userDataPath, 'LxDatas')
  if (!existsSync(global.lxDataPath)) {
    mkdirSync(global.lxDataPath, { recursive: true })
  }
}
