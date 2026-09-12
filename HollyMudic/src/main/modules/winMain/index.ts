import { global as electronGlobal } from 'electron'

export const sendShowUpdateAlert = (info: any) => {
  // 发送更新提示
  console.log('Show update alert:', info)
}

export const sendStatusChange = (status: LX.UserApi.UserApiStatus) => {
  // 发送状态变化
  console.log('Status change:', status)
}
