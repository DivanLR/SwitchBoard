// Content heuristic for automatic model routing (Settings → autoModelRouting).
// Questions and discussion route to the plan model (deep reasoning); requests
// to change code or run scripts route to the work model (the workhorse).
// Turn-granularity only — the SDK cannot switch models partway through a turn.
import { modelFamily } from '@shared/domain'

/** 'work' when the message asks to change code or run something, else 'plan'. */
export function classifyIntent(text: string): 'plan' | 'work' {
  const t = text.trim()
  if (t.length === 0) return 'plan'
  // A fenced code block or a diff is a concrete change, not a question.
  if (/```|^diff --git|^@@ /m.test(t)) return 'work'
  // A path with a code/config extension implies working on that file.
  if (/[\w./-]+\.(ts|tsx|js|jsx|vue|mjs|cjs|py|go|rs|java|kt|c|cpp|h|cs|rb|php|swift|sql|sh|ps1|json|ya?ml|toml|css|scss|html|md)\b/i.test(t)) {
    return 'work'
  }
  // Imperative code/execution verbs anywhere in the message.
  const workVerbs =
    /\b(implement|fix|refactor|add|remove|delete|drop|create|rename|move|write|edit|update|change|replace|build|compile|run|execute|install|uninstall|deploy|migrate|generate|scaffold|commit|push|revert|debug|patch|wire|bump|upgrade|downgrade|configure|set up|setup|rewrite|extract|inline|rename)\b/i
  if (workVerbs.test(t)) return 'work'
  // Default: questions and basic requests stay on the plan model.
  return 'plan'
}

// Downgrade ladder for usage-limit fallback: when a turn fails because the
// current model's usage limit is reached, opt to the next strongest FAMILY and
// name it by the CLI's family alias, which always points at the newest model in
// that family. Keying on families rather than on model ids keeps the ladder
// correct across model releases with no edit. Haiku has nowhere lower.
const DOWNGRADE: Record<string, string | null> = {
  fable: 'opus',
  opus: 'sonnet',
  sonnet: 'haiku',
  haiku: null,
}

/** The next strongest model to try when `current` is usage-limited, or null at
 *  the floor. The account default and any id naming no known family drop to the
 *  Sonnet workhorse (the common "weekly strong-model limit hit" case). */
export function nextStrongestModel(current: string | undefined): string | null {
  const family = modelFamily(current)
  if (!family) return 'sonnet'
  return DOWNGRADE[family] ?? null
}

/**
 * Reasoning effort for a resolved model under the "max effort unless Fable"
 * rule: the Fable family already reasons at depth, so it keeps its default
 * effort; every other model is pushed to 'max' ("ultra") to compensate. Returns
 * null (no override → account/CLI default) for Fable and for an
 * unknown/'default' id, where we cannot tell which family it resolves to — the
 * SDK-reported model reconciles that case. Models that do not support 'max'
 * silently downgrade.
 */
export function maxEffortUnlessFable(modelId: string | undefined): 'max' | null {
  if (!modelId || modelId === 'default' || modelFamily(modelId) === 'fable') return null
  return 'max'
}

export type Workload = 'plan' | 'advisor' | 'orchestrator'

// Signals that a work request is BROAD (many files / multi-step / research-
// shaped), which pays for the orchestrator pattern: strong model plans and
// delegates, cheap workers execute in parallel.
const BROAD_SCOPE =
  /\b(all|every|each|entire|whole|across)\b[\s\S]{0,40}\b(files?|tests?|modules?|components?|views?|routes?|endpoints?|pages?|screens?|repo|repositor\w*|codebase|project|app)\b/i
const HEAVY_WORK =
  /\b(audit|research|investigate|comprehensive|thorough(?:ly)?|end[- ]to[- ]end|overhaul|redesign|restyle|re-?architect|migrat\w+|in parallel|fan[- ]?out|orchestrat\w+|multi[- ]?step|sweep|whole app|entire app)\b/i

/**
 * Workload classification for the Advisor/Orchestrator modes ('auto'):
 * questions stay 'plan'; broad multi-step work → 'orchestrator' (strong model
 * runs the loop and delegates); everything else → 'advisor' (cheap executor
 * runs the loop, strong model consulted rarely).
 */
export function classifyWorkload(text: string): Workload {
  const t = text.trim()
  // A multi-item request (3+ bullets or numbered points) is a decomposable goal.
  const listItems = (t.match(/^\s*(?:[-*]|\d+[.)])\s+\S/gm) ?? []).length
  // Long prose briefs read as goals rather than single edits or questions.
  const broad = BROAD_SCOPE.test(t) || HEAVY_WORK.test(t) || listItems >= 3 || t.length > 600
  // Broad signals outrank the question gate: audits/research/deep-dives are
  // the orchestrator's home turf (parallel multi-source work) even when
  // phrased as a question rather than an imperative.
  if (broad) return 'orchestrator'
  return classifyIntent(text) === 'plan' ? 'plan' : 'advisor'
}
