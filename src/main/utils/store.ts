import Store from 'electron-store'
import { STORE_NAMES } from '@common/constants'

export default function getStore(name: string): Store {
  return new Store({ name })
}

export const initStores = () => {
  return {
    [STORE_NAMES.APP_SETTINGS]: new Store({ name: STORE_NAMES.APP_SETTINGS }),
    [STORE_NAMES.DATA]: new Store({ name: STORE_NAMES.DATA }),
    [STORE_NAMES.SYNC]: new Store({ name: STORE_NAMES.SYNC }),
    [STORE_NAMES.HOTKEY]: new Store({ name: STORE_NAMES.HOTKEY }),
    [STORE_NAMES.USER_API]: new Store({ name: STORE_NAMES.USER_API }),
    [STORE_NAMES.LRC_RAW]: new Store({ name: STORE_NAMES.LRC_RAW }),
    [STORE_NAMES.LRC_EDITED]: new Store({ name: STORE_NAMES.LRC_EDITED }),
    [STORE_NAMES.THEME]: new Store({ name: STORE_NAMES.THEME }),
    [STORE_NAMES.SOUND_EFFECT]: new Store({ name: STORE_NAMES.SOUND_EFFECT }),
  }
}
