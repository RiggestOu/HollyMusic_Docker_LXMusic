import { ref } from 'vue'

export const source = ref<string | null>(null)

export const qualityList = ref<Record<string, { size: string | null }>>({})

export const userApi = {
  list: [] as LX.UserApi.UserApiInfo[],
  status: false as boolean,
  message: 'initing' as string,
}

export const setUserSource = (sourceId: string) => {
  source.value = sourceId
}
