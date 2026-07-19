// Planned task queue per project (FR-023): prompts/goals that auto-run in
// sequence when the session goes idle. Backed by push.queueChanged.
import { defineStore } from 'pinia'
import type { QueuedTask } from '@shared/domain'
import type { QueueChangedPush } from '@shared/ipc-types'

interface QueueState {
  byProject: Record<string, QueuedTask[]>
}

export const useQueueStore = defineStore('queue', {
  state: (): QueueState => ({ byProject: {} }),

  getters: {
    forProject:
      (state) =>
      (projectId: string): QueuedTask[] =>
        state.byProject[projectId] ?? [],
  },

  actions: {
    async load(projectId: string): Promise<void> {
      this.byProject[projectId] = await window.switchboard.invoke('queue.list', { projectId })
    },

    async add(projectId: string, text: string): Promise<void> {
      if (text.trim().length === 0) return
      this.byProject[projectId] = await window.switchboard.invoke('queue.add', { projectId, text })
    },

    async remove(projectId: string, id: string): Promise<void> {
      this.byProject[projectId] = await window.switchboard.invoke('queue.remove', { projectId, id })
    },

    applyQueuePush(push: QueueChangedPush): void {
      this.byProject[push.projectId] = push.items
    },
  },
})
