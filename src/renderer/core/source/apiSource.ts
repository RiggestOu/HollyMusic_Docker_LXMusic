import { source, qualityList } from '@renderer/store'
import { appSetting, setApiSource } from '@renderer/store/setting'

let prevId = ''

export const setUserApi = async(apiId: string) => {
  if (prevId == apiId) return
  prevId = apiId

  if (window.lx.apiInitPromise[1]) {
    window.lx.apiInitPromise[0] = new Promise<boolean>(resolve => {
      window.lx.apiInitPromise[1] = false
      window.lx.apiInitPromise[2] = (result: boolean) => {
        window.lx.apiInitPromise[1] = true
        resolve(result)
      }
    })
  }

  if (/^user_source/.test(apiId)) {
    qualityList.value = {}
    source.status = false
    source.message = 'initing'

    await setApiSourceAction(apiId).then(() => {
      if (prevId != apiId) return
      source.value = apiId
    }).catch(err => {
      if (prevId != apiId) return
      if (!window.lx.apiInitPromise[1]) window.lx.apiInitPromise[2](false)
      console.log(err)
    })
  } else {
    // @ts-expect-error
    qualityList.value = musicSdk.supportQuality[apiId] ?? {}
    source.value = apiId
    void setApiSourceAction(apiId)
    if (!window.lx.apiInitPromise[1]) window.lx.apiInitPromise[2](true)
  }

  if (prevId != apiId) return
  if (apiId != appSetting['common.source']) setApiSource(apiId)
}

// 通过 IPC 调用主进程设置音源
const setApiSourceAction = async(apiId: string) => {
  await window.electron?.setSource(apiId)
}
