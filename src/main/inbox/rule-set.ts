import type { RiskClassificationRule, SwallowRule } from '@shared/domain'
import type { Repositories } from '@main/store/repositories'
import { effectiveRiskRules, effectiveSwallowRules } from './rule-prefs'

/**
 * The rules in force, held in memory and rebuilt when the developer changes one.
 *
 * Cached rather than resolved per use: the risk rules are consulted on every
 * permission check and the noise rules on every streamed event, so reading and
 * merging the override rows there would put a query on both hot paths.
 *
 * Reloaded rather than recreated, because both consumers hold this one object.
 * The permission broker takes it at construction and the noise classifier closes
 * over it, so an edit has to reach sessions that are already running — a rule the
 * developer just switched off should stop hiding output now, not after a restart.
 */
export class RuleSet {
  private risk: RiskClassificationRule[] = []
  private swallow: SwallowRule[] = []

  constructor(private readonly repos: Repositories) {
    this.reload()
  }

  reload(): void {
    const prefs = this.repos.rulePrefs.list()
    this.risk = effectiveRiskRules(prefs)
    this.swallow = effectiveSwallowRules(prefs)
  }

  riskRules(): RiskClassificationRule[] {
    return this.risk
  }

  swallowRules(): SwallowRule[] {
    return this.swallow
  }
}
