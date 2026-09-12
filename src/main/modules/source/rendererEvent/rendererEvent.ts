import { mainOn } from '@common/mainIpc'

import USER_SOURCE_RENDERER_EVENT_NAME from './name'
import { createWindow, getProxy, openDevTools, sendEvent } from '../main'
import { getUserApis } from '../utils'
import { sendShowUpdateAlert, sendStatusChange } from '@main/modules/winMain'

let userSource: LX.UserApi.UserApiInfo
let apiStatus: LX.UserApi.UserApiStatus = { status: true }
const requestQueue = new Map()
const timeouts = new Map<string, NodeJS.Timeout>()

interface InitParams {
  params: {
    status: boolean
    message: string
    data: LX.UserApi.UserApiInfo
  }
}

interface ResponseParams {
  params: {
    status: boolean
    message: string
    data: {
      requestKey: string
      result: any
    }
  }
}

interface UpdateInfoParams {
  params: {
    data: {
      log: string
      updateUrl: string
    }
  }
}

export const init = () => {
  const handleInit = ({ params: { status, message, data: apiInfo } }: InitParams) => {
    apiStatus = status
      ? { status: true, apiInfo: { ...userSource, sources: apiInfo.sources } }
      : { status: false, apiInfo: userSource, message }
    sendStatusChange(apiStatus)
  }
  const handleResponse = ({ params: { status, data: { requestKey, result }, message } }: ResponseParams) => {
    const request = requestQueue.get(requestKey)
    if (!request) return
    requestQueue.delete(requestKey)
    clearRequestTimeout(requestKey)
    if (status) {
      request[0](result)
    } else {
      request[1](new Error(message))
    }
  }
  const handleOpenDevTools = () => {
    openDevTools()
  }
  const handleShowUpdateAlert = ({ params: { data } }: UpdateInfoParams) => {
    if (!userSource.allowShowUpdateAlert) return
    sendShowUpdateAlert({
      name: userSource.name,
      description: userSource.description,
      log: data.log,
      updateUrl: data.updateUrl,
    })
  }
  const handleGetProxy = () => {
    sendEvent(USER_SOURCE_RENDERER_EVENT_NAME.proxyUpdate, getProxy())
  }
  mainOn(USER_SOURCE_RENDERER_EVENT_NAME.init, handleInit)
  mainOn(USER_SOURCE_RENDERER_EVENT_NAME.response, handleResponse)
  mainOn(USER_SOURCE_RENDERER_EVENT_NAME.openDevTools, handleOpenDevTools)
  mainOn(USER_SOURCE_RENDERER_EVENT_NAME.showUpdateAlert, handleShowUpdateAlert)
  mainOn(USER_SOURCE_RENDERER_EVENT_NAME.getProxy, handleGetProxy)
}

export const clearRequestTimeout = (requestKey: string) => {
  const timeout = timeouts.get(requestKey)
  if (timeout) {
    clearTimeout(timeout)
    timeouts.delete(requestKey)
  }
}

export const loadApi = async(apiId: string) => {
  if (!apiId) {
    apiStatus = { status: false, message: 'api id is null' }
    sendStatusChange(apiStatus)
    return
  }
  const targetApi = getUserApis().find(api => api.id == apiId)
  if (!targetApi) throw new Error('source not found')
  userSource = targetApi
  console.log('load source', userSource.name)
  await createWindow(userSource)
}

export const cancelRequest = (requestKey: string) => {
  if (!requestQueue.has(requestKey)) return
  const request = requestQueue.get(requestKey)
  request[1](new Error('Cancel request'))
  requestQueue.delete(requestKey)
  clearRequestTimeout(requestKey)
}

export const request = async({ requestKey, data }: LX.UserApi.UserApiRequestParams): Promise<any> => await new Promise((resolve, reject) => {
  if (!userSource) {
    reject(new Error('source is not loaded'))
  }

  const timeout = timeouts.get(requestKey)
  if (timeout) {
    clearTimeout(timeout)
    timeouts.delete(requestKey)
    cancelRequest(requestKey)
  }

  timeouts.set(requestKey, setTimeout(() => {
    cancelRequest(requestKey)
  }, 20000))

  requestQueue.set(requestKey, [resolve, reject, data])
  sendRequest({ requestKey, data })
})

export const getStatus = (): LX.UserApi.UserApiStatus => apiStatus

export const setAllowShowUpdateAlert = (id: string, enable: boolean) => {
  if (!userSource || userSource.id != id) return
  userSource.allowShowUpdateAlert = enable
}

export const sendRequest = (reqData: { requestKey: string, data: any }) => {
  sendEvent(USER_SOURCE_RENDERER_EVENT_NAME.request, reqData)
}
