// App auto-update state (GitHub releases). Subscribes to push.updateStatus and
// exposes check/install actions.
import { defineStore } from 'pinia'
import type { UpdateStatus } from '@shared/ipc-types'

export const useUpdatesStore = defineStore('updates', {
  state: (): { status: UpdateStatus } => ({ status: { state: 'idle' } }),

  getters: {
    ready: (s) => s.status.state === 'ready',
    busy: (s) => s.status.state === 'checking' || s.status.state === 'downloading',
  },

  actions: {
    apply(status: UpdateStatus): void {
      this.status = status
    },
    async check(): Promise<void> {
      await window.switchboard.invoke('updates.check', undefined)
    },
    async install(): Promise<void> {
      await window.switchboard.invoke('updates.install', undefined)
    },
  },
})
