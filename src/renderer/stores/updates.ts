// App auto-update state (GitHub releases). Subscribes to push.updateStatus and
// exposes check/install actions.
import { defineStore } from 'pinia'
import type { UpdateStatus } from '@shared/ipc-types'

export const useUpdatesStore = defineStore('updates', {
  state: (): { status: UpdateStatus } => ({ status: { state: 'idle' } }),

  getters: {
    // A newer release exists; "install" opens its download page (no auto-update).
    available: (s) => s.status.state === 'available',
    busy: (s) => s.status.state === 'checking',
  },

  actions: {
    apply(status: UpdateStatus): void {
      this.status = status
    },
    async check(): Promise<void> {
      await window.switchboard.invoke('updates.check', undefined)
    },
    /** Opens the latest release page in the browser to download the installer. */
    async install(): Promise<void> {
      await window.switchboard.invoke('updates.install', undefined)
    },
  },
})
