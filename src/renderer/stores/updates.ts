// App auto-update state (GitHub releases). Subscribes to push.updateStatus and
// exposes check/install actions.
import { computed, reactive, toRefs } from 'vue'
import type { UpdateStatus } from '@shared/ipc-types'
import { invoke } from '@renderer/ipc'

// State/derivations split the same way as stores/projects.ts (see there for
// why): the update banner reads five of these every render while a download
// ticks, and a plain `get` isn't cached by Vue.
const state = reactive({
  status: { state: 'idle' } as UpdateStatus,
})

/** A newer release exists (download not yet started). */
const available = computed((): boolean => state.status.state === 'available')

/** The banner stays up through the whole download/install flow, and through a
 *  failure. An update that starts downloading and then fails used to leave the
 *  banner state and vanish, so the app simply stayed on the old version with
 *  nothing said — the one outcome a developer needs told about. */
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

  /** Downloads the update inside the app and restarts into the installer. Falls
   *  back to the release page when the feed or the download is unusable. */
  async install(): Promise<void> {
    await invoke('updates.install', undefined)
  },
})

export const useUpdatesStore = (): typeof store => store
