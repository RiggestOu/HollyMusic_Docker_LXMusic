import { ipcMain } from 'electron'
import { ipcNames } from '@common/ipcNames'
import { getUserApis, importApi, removeApi } from '../modules/source'

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
    return removeApi(ids)
  })
}
