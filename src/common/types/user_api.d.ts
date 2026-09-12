declare namespace LX {
  type Source = 'kw' | 'tx' | 'kg' | 'mg' | 'wy' | 'local' | string
  
  type Quality = 'flac24bit' | 'flac' | 'wav' | 'ape' | '320k' | '192k' | '128k'
  
  namespace UserApi {
    type UserApiSourceInfoType = 'music'
    type UserApiSourceInfoActions = 'musicUrl' | 'lyric' | 'pic'

    interface UserApiSourceInfo {
      name: string
      type: UserApiSourceInfoType
      actions: UserApiSourceInfoActions[]
      qualitys: Quality[]
    }

    type UserApiSources = Record<Source, UserApiSourceInfo>

    interface UserApiInfoFull {
      id: string
      name: string
      description: string
      script: string
      allowShowUpdateAlert: boolean
      author?: string
      homepage?: string
      version?: string
      sources?: UserApiSources
    }

    type UserApiInfo = Omit<UserApiInfoFull, 'script'>

    interface UserApiStatus {
      status: boolean
      message?: string
      apiInfo?: UserApiInfo
    }

    interface UserApiRequestParams {
      requestKey: string
      data: any
    }

    interface ImportUserApi {
      apiInfo: UserApiInfo
      apiList: UserApiInfo[]
    }
  }

  interface AppSetting {
    'common.apiSource': string
    'common.sourceNameType': 'real' | 'alias'
    'network.proxy.enable': boolean
    'network.proxy.host': string
    'network.proxy.port': string
    'player.volume': number
    'player.isMute': boolean
  }
}
