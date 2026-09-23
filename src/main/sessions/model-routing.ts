import type { ModelMode } from '@shared/domain'

export function classifyIntent(text: string): 'plan' | 'work' {
  const t = text.trim()
  if (t.length === 0) return 'plan'
  if (/```|^diff --git|^@@ /m.test(t)) return 'work'
  if (/[\w./-]+\.(ts|tsx|js|jsx|vue|mjs|cjs|py|go|rs|java|kt|c|cpp|h|cs|rb|php|swift|sql|sh|ps1|json|ya?ml|toml|css|scss|html|md)\b/i.test(t)) {
    return 'work'
  }
  const workVerbs =
    /\b(implement|fix|refactor|add|remove|delete|drop|create|rename|move|write|edit|update|change|replace|build|compile|run|execute|install|uninstall|deploy|migrate|generate|scaffold|commit|push|revert|debug|patch|wire|bump|upgrade|downgrade|configure|set up|setup|rewrite|extract|inline|rename)\b/i
  if (workVerbs.test(t)) return 'work'
  return 'plan'
}

type Workload = 'plan' | 'advisor' | 'orchestrator'

export function mainLoopModel(
  mode: ModelMode | undefined,
  models: { intelligentModel?: string; workerModel?: string },
): string | undefined {
  return mode === 'advisor' || mode === 'basic'
    ? (models.workerModel ?? models.intelligentModel)
    : models.intelligentModel
}

const BROAD_SCOPE =
  /\b(all|every|each|entire|whole|across)\b[\s\S]{0,40}\b(files?|tests?|modules?|components?|views?|routes?|endpoints?|pages?|screens?|repo|repositor\w*|codebase|project|app)\b/i
const HEAVY_WORK =
  /\b(audit|research|investigate|comprehensive|thorough(?:ly)?|end[- ]to[- ]end|overhaul|redesign|restyle|re-?architect|migrat\w+|in parallel|fan[- ]?out|orchestrat\w+|multi[- ]?step|sweep|whole app|entire app)\b/i

export function classifyWorkload(text: string): Workload {
  const t = text.trim()
  const listItems = (t.match(/^\s*(?:[-*]|\d+[.)])\s+\S/gm) ?? []).length
  const broad = BROAD_SCOPE.test(t) || HEAVY_WORK.test(t) || listItems >= 3 || t.length > 600
  if (broad) return 'orchestrator'
  return classifyIntent(text) === 'plan' ? 'plan' : 'advisor'
}
