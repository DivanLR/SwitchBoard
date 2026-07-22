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
