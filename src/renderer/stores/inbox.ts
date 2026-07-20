// Central permission inbox state (FR-007..013): pending items grouped by
// project, decisions, history, and undeliverable-decision surfacing (SC-004).
import { defineStore } from 'pinia'
import type { DecisionRecord, PermissionRequest } from '@shared/domain'
import type { InboxChangedPush } from '@shared/ipc-types'

interface InboxState {
  pending: PermissionRequest[]
  history: DecisionRecord[]
  historyProjectId: string | null
  focusRequestId: string | null
  /** Banner shown when a decision could not reach its session (SC-004). */
  undeliverableNotice: string | null
}

export const useInboxStore = defineStore('inbox', {
  state: (): InboxState => ({
    pending: [],
    history: [],
    historyProjectId: null,
    focusRequestId: null,
    undeliverableNotice: null,
  }),

  getters: {
    /** Grouped by project, oldest first within each group (clarified FIFO). */
    groups(state): { projectId: string; items: PermissionRequest[] }[] {
      const byProject = new Map<string, PermissionRequest[]>()
      for (const item of state.pending) {
        const list = byProject.get(item.projectId) ?? []
        list.push(item)
        byProject.set(item.projectId, list)
      }
      return [...byProject.entries()].map(([projectId, items]) => ({
        projectId,
        items: [...items].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      }))
    },
    pendingCount(state): number {
      return state.pending.length
    },
  },

  actions: {
    async refresh(): Promise<void> {
      this.pending = await window.switchboard.invoke('inbox.pending', undefined)
    },

    async decide(
      requestId: string,
      decision: 'approve' | 'deny',
      confirmHighRisk = false,
    ): Promise<boolean> {
      const result = await window.switchboard.invoke('inbox.decide', {
        requestId,
        decision,
        confirmHighRisk,
      })
      if (!result.delivered) {
        this.undeliverableNotice =
          'The decision could not be delivered: the originating session has ended. The item was marked expired.'
      }
      return result.delivered
    },

    async alwaysAllow(requestId: string): Promise<void> {
      // From a decided history entry; the matcher is derived server-side.
      await window.switchboard.invoke('inbox.alwaysAllow', { requestId })
    },

    async deleteHistory(requestId: string): Promise<void> {
      await window.switchboard.invoke('inbox.deleteHistory', { requestId })
      this.history = this.history.filter((h) => h.id !== requestId)
    },

    async clearHistory(): Promise<void> {
      await window.switchboard.invoke('inbox.clearHistory', undefined)
      this.history = []
    },

    async approveAllForProject(
      projectId: string,
    ): Promise<{ approved: number; skippedHighRisk: number }> {
      return window.switchboard.invoke('inbox.approveAllForProject', { projectId })
    },

    async loadHistory(projectId?: string): Promise<void> {
      this.historyProjectId = projectId ?? null
      this.history = await window.switchboard.invoke('inbox.history', { projectId })
    },

    applyInboxPush(push: InboxChangedPush): void {
      if (push.added) {
        const added = push.added
        if (!this.pending.some((p) => p.id === added.id)) {
          this.pending.push(added)
        }
      }
      if (push.resolved) {
        const requestId = push.resolved.requestId
        this.pending = this.pending.filter((p) => p.id !== requestId)
        if (push.resolved.deliveryFailed) {
          this.undeliverableNotice =
            'A decision could not be delivered to its session and was marked expired.'
        }
      }
    },

    focusRequest(requestId: string): void {
      this.focusRequestId = requestId
    },

    dismissNotice(): void {
      this.undeliverableNotice = null
    },
  },
})
