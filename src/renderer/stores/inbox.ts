// Central permission inbox state (FR-007..013): pending items grouped by
// project, decisions, history, and undeliverable-decision surfacing (SC-004).
import { computed, reactive, toRefs } from 'vue'
import type { DecisionRecord, PermissionRequest, PermissionRule } from '@shared/domain'
import type { InboxChangedPush } from '@shared/ipc-types'
import { invoke } from '@renderer/ipc'

const UNDELIVERABLE_DECISION =
  'The decision could not be delivered: the originating session has ended. The item was marked expired.'

// Ticket per history load, so an older reply cannot replace a newer one.
let historyLoad = 0

// State and derivations are declared separately so the derivations can be real
// `computed()`s. A plain `get` on a reactive object is NOT cached by Vue: it
// re-runs on every property read, which for `groups` meant rebuilding a Map and
// re-sorting on every access — including once per render of every template that
// touches it. Spread back in through `toRefs`, the store's public shape is
// unchanged (reactive unwraps both refs and computeds on read).
const state = reactive({
  pending: [] as PermissionRequest[],
  history: [] as DecisionRecord[],
  focusRequestId: null as string | null,
  /** Banner shown when a decision could not reach its session (SC-004). */
  undeliverableNotice: null as string | null,
})

/** Grouped by project, oldest first within each group (clarified FIFO). */
const groups = computed((): { projectId: string; items: PermissionRequest[] }[] => {
  const byProject = Object.groupBy(state.pending, (item) => item.projectId)
  return Object.entries(byProject).map(([projectId, items]) => ({
    projectId,
    // Object.groupBy types every value as possibly absent, because the key type is
    // wider than the keys it actually produced. A key only exists here because an
    // item produced it, so no group is ever empty.
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
    // From a decided history entry; the matcher is derived server-side.
    await invoke('inbox.alwaysAllow', { requestId })
  },

  /** From a pending item: server-side inserts the rule, then approves.
   *  confirmHighRisk gates the broad MCP tool_only grant (high by fail-safe). */
  async approveAlways(requestId: string, confirmHighRisk = false): Promise<boolean> {
    const result = await invoke('inbox.approveAlways', {
      requestId,
      confirmHighRisk,
    })
    if (!result.delivered) state.undeliverableNotice = UNDELIVERABLE_DECISION
    return result.delivered
  },

  /** Active Bash command-prefix values already allowed for a project (so the
   *  history menu can hide "Always allow" for commands a rule already covers). */
  async allowedCommandBases(projectId: string): Promise<string[]> {
    const rules = await this.listStandingRules(projectId, false)
    return rules
      .filter(
        (r) => r.toolName === 'Bash' && r.matcher.kind === 'command_prefix' && r.matcher.value,
      )
      .map((r) => r.matcher.value as string)
  },

  /** Standing (always-allow) command rules for a project — Allowed-list tab. */
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

  /** Ticketed so a reply for one filter cannot land after a newer one and leave
   *  the list showing a project the view is no longer on. */
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

  /** Clear the "scroll to this item" signal once the view has consumed it. */
  clearFocusRequest(): void {
    state.focusRequestId = null
  },

  dismissNotice(): void {
    state.undeliverableNotice = null
  },
})

export const useInboxStore = (): typeof store => store
