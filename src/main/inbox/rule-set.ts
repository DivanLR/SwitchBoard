import type { RiskClassificationRule, SwallowRule } from '@shared/domain'
import { defaultRiskRules } from './risk-rules'
import { defaultSwallowRules } from '@main/stream/swallow-rules'

export class RuleSet {
  riskRules(): RiskClassificationRule[] {
    return defaultRiskRules()
  }

  swallowRules(): SwallowRule[] {
    return defaultSwallowRules()
  }
}
