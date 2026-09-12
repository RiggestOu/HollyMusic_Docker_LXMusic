import { contextBridge, ipcRenderer } from 'electron'
import { ipcNames } from '@common/ipcNames'

// 暴露安全的 API 到渲染进程
contextBridge.exposeInMainWorld('electron', {
  // 音源相关 API
  setSource: (id: string) => ipcRenderer.invoke(ipcNames.setSource, id),
  getSourceList: () => ipcRenderer.invoke(ipcNames.getSourceList),
  importSource: (script: string) => ipcRenderer.invoke(ipcNames.importSource, script),
  removeSource: (ids: string[]) => ipcRenderer.invoke(ipcNames.removeSource, ids),
  setAllowShowUpdateAlert: (id: string, enable: boolean) =>
    ipcRenderer.invoke(ipcNames.setAllowShowUpdateAlert, id, enable),
})

// 暴露应用数据到全局
contextBridge.exposeInMainWorld('lxData', {
  appSetting: ipcRenderer.sendSync('get-app-setting'),
  updateSetting: (setting: any) => ipcRenderer.send('update-app-setting', setting),
  versionInfo: { version: '1.0.0' },
})
