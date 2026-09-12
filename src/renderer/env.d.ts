import type { UserApiInfo, UserApiSourceInfo } from '@common/types/user_api'

declare global {
  interface Window {
    lxData: {
      appSetting: LX.AppSetting
      updateSetting: (setting: Partial<LX.AppSetting>) => void
      versionInfo: any
    }
    electron: {
      setSource: (id: string) => Promise<{ success: boolean; error?: string }>
      getSourceList: () => Promise<UserApiInfo[]>
      importSource: (script: string) => Promise<{ success: boolean; apiInfo?: UserApiInfo; error?: string }>
      removeSource: (ids: string[]) => Promise<UserApiInfo[]>
      setAllowShowUpdateAlert: (id: string, enable: boolean) => Promise<boolean>
    }
  }
}
