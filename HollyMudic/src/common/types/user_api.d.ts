declare namespace LX {
  type Source = 'kw' | 'tx' | 'kg' | 'mg' | 'wy' | 'local' | string
  
  type Quality = 'flac24bit' | 'flac' | 'wav' | 'ape' | '320k' | '192k' | '128k'
  
  type QualityList = Record<Quality, { size: string | null }>

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

  namespace Music {
    interface MusicInfoBase<S = LX.Source> {
      id: string
      name: string
      singer: string
      source: S
      interval: string | null
      meta: MusicInfoMetaBase
    }

    interface MusicInfoMetaBase {
      songId: string | number
      albumName: string
      picUrl?: string | null
    }

    interface MusicInfoOnline extends MusicInfoBase<LX.Source> {
      meta: MusicInfoMeta_online
    }

    interface MusicInfoMeta_online extends MusicInfoMetaBase {
      qualitys: MusicQualityType[]
      _qualitys: Record<Quality, { size: string | null }>
    }

    interface MusicQualityType {
      type: Quality
      size: string | null
    }
  }

  namespace Ipc {
    type IpcMainEventListener = (params: any) => void
    type IpcMainEventListenerParams<T> = (params: { params: T }) => void
    type IpcMainInvokeEventListenerParams<T, V> = (params: { params: T }) => Promise<V>
    type IpcRendererEventListener = (params: any) => void
  }

  namespace Player {
    type Status = 'stoped' | 'playing' | 'paused' | 'error'
  }

  interface AppSetting {
    'common.apiSource': string
    'common.sourceNameType': 'real' | 'alias'
    'common.transparentWindow': boolean
    'common.windowSizeId': number
    'network.proxy.enable': boolean
    'network.proxy.host': string
    'network.proxy.port': string
    'player.volume': number
    'player.isMute': boolean
    'player.togglePlayMethod': 'single' | 'list' | 'shuffle' | 'repeat'
  }
}
