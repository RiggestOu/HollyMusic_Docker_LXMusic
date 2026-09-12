import { ref, onMounted } from 'vue'

const currentSource = ref<string>('')
const sourceList = ref<LX.UserApi.UserApiInfo[]>([])
const statusMessage = ref<string>('')
const statusType = ref<'ok' | 'error'>('ok')

onMounted(async () => {
  try {
    const list = await window.electron?.getSourceList()
    sourceList.value = list || []
  } catch (e: any) {
    console.error('Failed to load source list:', e)
    statusMessage.value = '加载音源列表失败'
    statusType.value = 'error'
  }
})

export default {
  setup() {
    return {
      currentSource,
      sourceList,
      statusMessage,
      statusType,
    }
  },
}
