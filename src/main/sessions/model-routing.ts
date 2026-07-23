// Content heuristic for automatic model routing (Settings → autoModelRouting).
// Questions and discussion route to the plan model (deep reasoning); requests
// to change code or run scripts route to the work model (the workhorse).
// Turn-granularity only — the SDK cannot switch models partway through a turn.

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
