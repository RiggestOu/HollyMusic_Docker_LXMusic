declare namespace LX {
  type Source = 'kw' | 'tx' | 'kg' | 'mg' | 'wy' | 'local' | string
  type Quality = 'flac24bit' | 'flac' | 'wav' | 'ape' | '320k' | '192k' | '128k'
  
  namespace UserApi {
    interface UserApiInfoFull {
      id: string
      name: string
      description: string
      script: string
      allowShowUpdateAlert: boolean
      sources?: Record<Source, any>
    }
    type UserApiInfo = Omit<UserApiInfoFull, 'script'>
    interface UserApiStatus {
      status: boolean
      message?: string
    }
    interface UserApiRequestParams {
      requestKey: string
      data: any
    }
  }
  
  interface AppSetting {
    'common.apiSource': string
    'network.proxy.enable': boolean
    'network.proxy.host': string
    'network.proxy.port': string
  }
}
