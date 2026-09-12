import { computed, reactive, toRefs } from 'vue'
import type { UpdateStatus } from '@shared/ipc-types'
import { invoke } from '@renderer/ipc'

const state = reactive({
  status: { state: 'idle' } as UpdateStatus,
})

const available = computed((): boolean => state.status.state === 'available')

const active = computed((): boolean =>
  ['available', 'downloading', 'ready', 'error'].includes(state.status.state),
)

const failed = computed((): boolean => state.status.state === 'error')

const downloading = computed((): boolean => state.status.state === 'downloading')
const ready = computed((): boolean => state.status.state === 'ready')
const percent = computed((): number => state.status.percent ?? 0)
const busy = computed((): boolean => state.status.state === 'checking')

const store = reactive({
  ...toRefs(state),
  available,
  active,
  downloading,
  failed,
  ready,
  percent,
  busy,

  apply(status: UpdateStatus): void {
    state.status = status
  },

  async check(): Promise<void> {
    await invoke('updates.check', undefined)
  },

  async install(): Promise<void> {
    await invoke('updates.install', undefined)
  },
})

export const useUpdatesStore = (): typeof store => store
