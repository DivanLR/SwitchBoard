// App auto-update state (GitHub releases). Subscribes to push.updateStatus and
// exposes check/install actions.
import { computed, reactive, toRefs } from 'vue'
import type { UpdateStatus } from '@shared/ipc-types'
import { invoke } from '@renderer/ipc'

// State and derivations are declared separately so the derivations can be real
// `computed()`s (the same split as stores/projects.ts). A plain `get` on a
// reactive object is NOT cached by Vue — it re-runs on every read, and the
// update banner reads five of these on every render while a download ticks.
// Spread back in through `toRefs`, the public shape of the store is unchanged.
const state = reactive({
  status: { state: 'idle' } as UpdateStatus,
})

/** A newer release exists (download not yet started). */
const available = computed((): boolean => state.status.state === 'available')

/** The banner stays up through the whole download/install flow. */
const active = computed((): boolean =>
  ['available', 'downloading', 'ready'].includes(state.status.state),
)

const downloading = computed((): boolean => state.status.state === 'downloading')
const ready = computed((): boolean => state.status.state === 'ready')
const percent = computed((): number => state.status.percent ?? 0)
const busy = computed((): boolean => state.status.state === 'checking')

const store = reactive({
  ...toRefs(state),
  available,
  active,
  downloading,
  ready,
  percent,
  busy,

  apply(status: UpdateStatus): void {
    state.status = status
  },

  async check(): Promise<void> {
    await invoke('updates.check', undefined)
  },

  /** Downloads the update inside the app and restarts into the installer. Falls
   *  back to the release page when the feed or the download is unusable. */
  async install(): Promise<void> {
    await invoke('updates.install', undefined)
  },
})

export const useUpdatesStore = (): typeof store => store
