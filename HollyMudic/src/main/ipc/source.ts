import { ipcMain, dialog, app } from 'electron'
import { ipcNames } from '@common/ipcNames'
import { STORE_NAMES } from '@common/constants'
import Store from 'electron-store'
import { importApi, removeApi, getUserApis, setAllowShowUpdateAlert, loadApi } from './modules/source'
import { createSourceWindow } from './window'

const store = new Store({
  name: STORE_NAMES.USER_API,
})

// 注册音源相关 IPC 处理器
export function registerSourceHandlers() {
  // 获取音源列表
  ipcMain.handle(ipcNames.getSourceList, async () => {
    return getUserApis()
  })

  // 导入音源
  ipcMain.handle(ipcNames.importSource, async (_event, script: string) => {
    try {
      const apiInfo = await importApi(script)
      return { success: true, apiInfo }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  })

  // 删除音源
  ipcMain.handle(ipcNames.removeSource, async (_event, ids: string[]) => {
    const result = removeApi(ids)
    return result
  })

  // 设置允许显示更新提示
  ipcMain.handle(ipcNames.setAllowShowUpdateAlert, async (_event, id: string, enable: boolean) => {
    setAllowShowUpdateAlert(id, enable)
    return true
  })

  // 设置当前使用的音源
  let currentSourceWindow: Electron.BrowserWindow | null = null
  
  ipcMain.handle(ipcNames.setSource, async (_event, id: string) => {
    try {
      const apiList = getUserApis()
      const targetApi = apiList.find(a => a.id === id)
      if (!targetApi) {
        throw new Error('音源不存在')
      }
      
      // 关闭旧窗口
      if (currentSourceWindow) {
        currentSourceWindow.destroy()
        currentSourceWindow = null
      }
      
      // 创建新窗口
      currentSourceWindow = createSourceWindow(targetApi)
      currentSourceWindow.show()
      
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  })
}

// 导出必要的函数供其他模块使用
export { getUserApis, importApi, removeApi }
