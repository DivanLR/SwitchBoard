// Planned task queue per project (FR-023): prompts/goals that auto-run in
// sequence when the session goes idle. Backed by push.queueChanged.
import { reactive } from 'vue'
import type { QueuedTask } from '@shared/domain'
import type { QueueChangedPush } from '@shared/ipc-types'
import { invoke } from '@renderer/ipc'

const store = reactive({
  byProject: {} as Record<string, QueuedTask[]>,

  forProject(projectId: string): QueuedTask[] {
    return this.byProject[projectId] ?? []
  },

  async load(projectId: string): Promise<void> {
    this.byProject[projectId] = await invoke('queue.list', { projectId })
  },

  async add(projectId: string, text: string): Promise<void> {
    if (text.trim().length === 0) return
    this.byProject[projectId] = await invoke('queue.add', { projectId, text })
  },

  /** Reword a queued task. Saving it empty removes it, which is what clearing
   *  the box means. */
  async edit(projectId: string, id: string, text: string): Promise<void> {
    this.byProject[projectId] = await invoke('queue.edit', { projectId, id, text })
  },

  async remove(projectId: string, id: string): Promise<void> {
    this.byProject[projectId] = await invoke('queue.remove', { projectId, id })
  },

  applyQueuePush(push: QueueChangedPush): void {
    this.byProject[push.projectId] = push.items
  },
})

export const useQueueStore = (): typeof store => store
