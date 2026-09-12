import { computed, reactive, toRefs } from 'vue'
import type { DecisionRecord, PermissionRequest, PermissionRule } from '@shared/domain'
import type { InboxChangedPush } from '@shared/ipc-types'
import { invoke } from '@renderer/ipc'

const UNDELIVERABLE_DECISION =
  'The decision could not be delivered: the originating session has ended. The item was marked expired.'

let historyLoad = 0

const state = reactive({
  pending: [] as PermissionRequest[],
  history: [] as DecisionRecord[],
  focusRequestId: null as string | null,
  undeliverableNotice: null as string | null,
})

const groups = computed((): { projectId: string; items: PermissionRequest[] }[] => {
  const byProject = Object.groupBy(state.pending, (item) => item.projectId)
  return Object.entries(byProject).map(([projectId, items]) => ({
    projectId,
    items: [...(items ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  }))
})

const pendingCount = computed((): number => state.pending.length)

const store = reactive({
  ...toRefs(state),
  groups,
  pendingCount,

  async refresh(): Promise<void> {
    state.pending = await invoke('inbox.pending', undefined)
  },

  async decide(
    requestId: string,
    decision: 'approve' | 'deny',
    confirmHighRisk = false,
  ): Promise<boolean> {
    const result = await invoke('inbox.decide', {
      requestId,
      decision,
      confirmHighRisk,
    })
    if (!result.delivered) state.undeliverableNotice = UNDELIVERABLE_DECISION
    return result.delivered
  },

  async alwaysAllow(requestId: string): Promise<void> {
    await invoke('inbox.alwaysAllow', { requestId })
  },

  async approveAlways(requestId: string, confirmHighRisk = false): Promise<boolean> {
    const result = await invoke('inbox.approveAlways', {
      requestId,
      confirmHighRisk,
    })
    if (!result.delivered) state.undeliverableNotice = UNDELIVERABLE_DECISION
    return result.delivered
  },

  async allowedCommandBases(projectId: string): Promise<string[]> {
    const rules = await this.listStandingRules(projectId, false)
    return rules
      .filter(
        (r) => r.toolName === 'Bash' && r.matcher.kind === 'command_prefix' && r.matcher.value,
      )
      .map((r) => r.matcher.value as string)
  },

  async listStandingRules(projectId: string, includeRevoked = false): Promise<PermissionRule[]> {
    return invoke('rules.standing.list', { projectId, includeRevoked })
  },

  async revokeStandingRule(ruleId: string): Promise<void> {
    await invoke('rules.standing.revoke', { ruleId })
  },

  async restoreStandingRule(ruleId: string): Promise<void> {
    await invoke('rules.standing.restore', { ruleId })
  },

  async addStandingRule(projectId: string, pattern: string): Promise<PermissionRule> {
    return invoke('rules.standing.add', { projectId, pattern })
  },

  async deleteHistory(requestId: string): Promise<void> {
    await invoke('inbox.deleteHistory', { requestId })
    state.history = state.history.filter((h) => h.id !== requestId)
  },

  async clearHistory(): Promise<void> {
    await invoke('inbox.clearHistory', undefined)
    state.history = []
  },

  async approveAllForProject(
    projectId: string,
    includeHighRisk = false,
  ): Promise<{ approved: number; skippedHighRisk: number }> {
    return invoke('inbox.approveAllForProject', { projectId, includeHighRisk })
  },

  async loadHistory(projectId?: string): Promise<void> {
    const ticket = (historyLoad += 1)
    const history = await invoke('inbox.history', { projectId })
    if (ticket === historyLoad) state.history = history
  },

  applyInboxPush(push: InboxChangedPush): void {
    if (push.added) {
      const added = push.added
      if (!state.pending.some((p) => p.id === added.id)) {
        state.pending.push(added)
      }
    }
    if (push.resolved) {
      const requestId = push.resolved.requestId
      state.pending = state.pending.filter((p) => p.id !== requestId)
      if (push.resolved.deliveryFailed) {
        state.undeliverableNotice =
          'A decision could not be delivered to its session and was marked expired.'
      }
    }
  },

  focusRequest(requestId: string): void {
    state.focusRequestId = requestId
  },

  clearFocusRequest(): void {
    state.focusRequestId = null
  },

  dismissNotice(): void {
    state.undeliverableNotice = null
  },
})

export const useInboxStore = (): typeof store => store
