// Risk classification and noise rules the developer owns (PRODUCT.md Principle 3).
//
// Every mutation answers with the whole list, so there is no reload step and no
// window where the editor shows a half-applied change.
import { computed, reactive, toRefs } from 'vue'
import type { RiskLevel, RuleKind } from '@shared/domain'
import type { RiskRuleView, SwallowRuleView } from '@shared/ipc-types'
import { invoke } from '@renderer/ipc'

const state = reactive({
  risk: [] as RiskRuleView[],
  swallow: [] as SwallowRuleView[],
  loaded: false,
})

/**
 * Whether anything has been changed from the shipped defaults.
 *
 * A real computed rather than a getter: the editor header reads it on every render
 * and it scans both lists (see the store rule in CLAUDE.md).
 */
const modified = computed(
  (): boolean =>
    state.risk.some((r) => r.disabled || r.overridden || !r.builtin) ||
    state.swallow.some((r) => r.disabled || !r.builtin),
)

function apply(view: { risk: RiskRuleView[]; swallow: SwallowRuleView[] }): void {
  state.risk = view.risk
  state.swallow = view.swallow
  state.loaded = true
}

const store = reactive({
  ...toRefs(state),
  modified,

  async load(): Promise<void> {
    apply(await invoke('rules.list', undefined))
  },

  async setDisabled(id: string, kind: RuleKind, disabled: boolean): Promise<void> {
    apply(await invoke('rules.setDisabled', { id, kind, disabled }))
  },

  /** null restores the shipped level. */
  async setRisk(id: string, risk: RiskLevel | null): Promise<void> {
    apply(await invoke('rules.setRisk', { id, risk }))
  },

  async addRisk(toolMatcher: string, pattern: string | null, risk: RiskLevel): Promise<void> {
    apply(await invoke('rules.addRisk', { toolMatcher, pattern, risk }))
  },

  async addSwallow(eventKindMatcher: string, pattern: string, noiseKind: string): Promise<void> {
    apply(await invoke('rules.addSwallow', { eventKindMatcher, pattern, noiseKind }))
  },

  /** Deletes a rule the developer wrote; restores the default for a shipped one. */
  async remove(id: string, kind: RuleKind): Promise<void> {
    apply(await invoke('rules.remove', { id, kind }))
  },
})

export const useRulesStore = (): typeof store => store
