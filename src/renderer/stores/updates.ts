// App auto-update state (GitHub releases). Subscribes to push.updateStatus and
// exposes check/install actions.
import { reactive } from 'vue'
import type { UpdateStatus } from '@shared/ipc-types'
import { invoke } from '@renderer/ipc'

const store = reactive({
  status: { state: 'idle' } as UpdateStatus,

  /** A newer release exists (download not yet started). */
  get available(): boolean {
    return this.status.state === 'available'
  },
  /** The banner stays up through the whole download/install flow. */
  get active(): boolean {
    return ['available', 'downloading', 'ready'].includes(this.status.state)
  },
  get downloading(): boolean {
    return this.status.state === 'downloading'
  },
  get ready(): boolean {
    return this.status.state === 'ready'
  },
  get percent(): number {
    return this.status.percent ?? 0
  },
  get busy(): boolean {
    return this.status.state === 'checking'
  },

  apply(status: UpdateStatus): void {
    this.status = status
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
