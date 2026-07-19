// Rules transport (FR-008a, FR-009b, FR-015a). The store owns every rules IPC
// call; the rule-editor component keeps local editable buffers and calls these
// actions to load, persist, and revoke (view/transport separation).
import { defineStore } from 'pinia'
import type { PermissionRule, RiskClassificationRule, SwallowRule } from '@shared/domain'

export const useRulesStore = defineStore('rules', {
  actions: {
    listStanding(projectId: string): Promise<PermissionRule[]> {
      return window.switchboard.invoke('rules.standing.list', { projectId })
    },
    revokeStanding(ruleId: string): Promise<void> {
      return window.switchboard.invoke('rules.standing.revoke', { ruleId })
    },

    listRisk(): Promise<RiskClassificationRule[]> {
      return window.switchboard.invoke('rules.risk.list', undefined)
    },
    saveRisk(rules: RiskClassificationRule[]): Promise<RiskClassificationRule[]> {
      return window.switchboard.invoke('rules.risk.save', { rules })
    },
    restoreRiskDefaults(): Promise<RiskClassificationRule[]> {
      return window.switchboard.invoke('rules.risk.restoreDefaults', undefined)
    },

    listSwallow(): Promise<SwallowRule[]> {
      return window.switchboard.invoke('rules.swallow.list', {})
    },
    saveSwallow(rules: SwallowRule[]): Promise<SwallowRule[]> {
      return window.switchboard.invoke('rules.swallow.save', { rules })
    },
    restoreSwallowDefaults(): Promise<SwallowRule[]> {
      return window.switchboard.invoke('rules.swallow.restoreDefaults', undefined)
    },
  },
})
