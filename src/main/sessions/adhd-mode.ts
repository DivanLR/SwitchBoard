// ADHD output style as the backbone of every hosted session: an authored
// system-prompt append (the compact ruleset the i-have-adhd project recommends
// embedding in instruction files) so sessions Switchboard spawns are shaped the
// same way as the global always-on plugin — action-first, numbered, no preamble.
//
// Gated on the SAME opt-in as the global plugin: the flag file
// `$CLAUDE_CONFIG_DIR/.i-have-adhd-always` (default `~/.claude`). One switch
// governs both: create it to turn ADHD on everywhere, delete it to turn it off.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Hard directive + reinforcement, same framing as terse-mode, so the style is
// not diluted by the large Claude Code preset system prompt it appends to.
const ADHD_APPEND =
  '## MANDATORY OUTPUT STYLE — ADHD READER. THIS OVERRIDES DEFAULT VERBOSITY.\n' +
  'A hard constraint on every response this session, including the first. Shape ' +
  'each reply so it can be acted on:\n' +
  '1. Lead with the answer or next action: command, path, or snippet first.\n' +
  '2. Number multi-step work; one bounded action per step.\n' +
  '3. End with one next action doable in under two minutes.\n' +
  '4. Finish the current issue before raising a new one.\n' +
  '5. Restate progress each turn ("step 3 of 5 done").\n' +
  '6. Give time estimates in concrete units, never "a bit".\n' +
  '7. After a change, show what now works.\n' +
  '8. Errors: state location, cause, and fix. No drama.\n' +
  '9. Cap lists at 5 items; rank rather than pad.\n' +
  '10. No preamble, no recaps, no closers.\n' +
  'Exceptions: explain fully when asked to explain; confirm before destructive ' +
  'actions; after three failed fixes, stop and name the doubtful assumption; if ' +
  'the request is ambiguous, ask one short question. Never trade a required step, ' +
  'code, command, path, or error text for brevity — reproduce those exactly.'

/** Path to the i-have-adhd always-on flag, honoring CLAUDE_CONFIG_DIR. */
function flagPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  return join(dir, '.i-have-adhd-always')
}

/** The ADHD append when always-on is enabled, else null. */
export function adhdSystemPromptAppend(): string | null {
  return existsSync(flagPath()) ? ADHD_APPEND : null
}
