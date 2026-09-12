import type { RiskClassificationRule, SwallowRule } from '@shared/domain'
import type { Repositories } from '@main/store/repositories'
import { effectiveRiskRules, effectiveSwallowRules } from './rule-prefs'

export class RuleSet {
  private risk: RiskClassificationRule[] = []
  private swallow: SwallowRule[] = []

  constructor(private readonly repos: Repositories) {
    this.reload()
  }

  reload(): void {
    const prefs = this.repos.rulePrefs.list()
    this.risk = [...effectiveRiskRules(prefs)].sort((a, b) => a.position - b.position)
    this.swallow = effectiveSwallowRules(prefs)
  }

  riskRules(): RiskClassificationRule[] {
    return this.risk
  }

  swallowRules(): SwallowRule[] {
    return this.swallow
  }
}
