// The three things an acceptance line dispatches to the session, and how the
// answer is read back (spec 002 US7 + the Coordinator-Implementor-Verifier
// pattern: implement in isolation, then pass a deterministic gate).
//
// Everything runs THROUGH the session (FR-041) — nothing here spawns a process.
// The gate is made deterministic the only way that leaves the session in charge:
// the prompt demands one machine-readable line, and the main process reads that
// line off the session's own events. No line, no pass (FR-047).
import type { EvalCheckStatus } from '@shared/domain'

/** Sentinels the session is told to emit. Deliberately unmistakable. */
export const CHECK_MARKER = 'EVAL_CHECK'
export const JUDGE_MARKER = 'EVAL_JUDGE'

/** Verify: run the check and report its real outcome, nothing else. */
export function checkPrompt(acceptance: string, command: string): string {
  return (
    `Verify this acceptance line: "${acceptance}"\n\n` +
    `Run exactly: ${command}\n\n` +
    'Report the REAL outcome. Do not fix anything, do not edit files, do not ' +
    'interpret a failure as a pass. Finish your reply with one line, on its own:\n' +
    `${CHECK_MARKER}: PASS   (only if the command exited successfully)\n` +
    `${CHECK_MARKER}: FAIL   (it ran and something failed)\n` +
    `${CHECK_MARKER}: INCONCLUSIVE   (it could not run, or the output proves nothing)`
  )
}

/**
 * Implement: N independent attempts, each isolated in its own git worktree, then
 * one report saying which passed the check. Best-of-N — the developer keeps the
 * winner.
 *
 * ponytail: the isolation is the session agent's own worktree support, not
 * worktrees managed here. Managing them in the app would mean lifting the
 * one-live-session-per-project rule first; do that only if attempts need to be
 * driven from the app while the session is busy elsewhere.
 */
export function attemptsPrompt(acceptance: string, command: string | null, attempts: number): string {
  return (
    `Acceptance line: "${acceptance}"\n\n` +
    `Produce ${attempts} INDEPENDENT attempts at it, each in its own git worktree so they ` +
    'cannot conflict (spawn them in parallel, one agent per attempt, worktree isolation).\n' +
    (command
      ? `Verify every attempt with: ${command}\n`
      : 'Verify every attempt by launching the app and looking at the affected screen.\n') +
    'Then report, in one message: which attempts passed, the shortest diff among those that ' +
    'passed, and what each attempt did differently. Recommend one. Leave the others in place ' +
    'for me to compare — do not merge or delete anything without asking.'
  )
}

/** Review: a second opinion on the diff against the acceptance line. */
export function judgePrompt(acceptance: string): string {
  return (
    `Judge the current diff against this acceptance line: "${acceptance}"\n\n` +
    'Use the `advisor` subagent so this is a second opinion, not the same reasoning again. ' +
    'Answer: does the diff actually satisfy the line, what is the strongest reason it might ' +
    'not, and what is untested. Do not change any code.\n' +
    `Finish with one line, on its own: ${JUDGE_MARKER}: <verdict in under 20 words>`
  )
}

/** What the session reported, or null when this text carries no marker. */
export type EvalMarker =
  | { kind: 'check'; status: EvalCheckStatus }
  | { kind: 'judge'; verdict: string }

const CHECK_RE = new RegExp(`^\\s*\\**${CHECK_MARKER}\\**\\s*:\\s*\\**\\s*(PASS|FAIL|INCONCLUSIVE)`, 'im')
const JUDGE_RE = new RegExp(`^\\s*\\**${JUDGE_MARKER}\\**\\s*:\\s*(.+)$`, 'im')

/**
 * Read a marker out of session text. The LAST occurrence wins: the prompt text
 * itself echoes the sentinels, and a turn may restate them, so an early mention
 * must never be mistaken for the answer.
 */
export function parseEvalMarker(text: string): EvalMarker | null {
  const check = lastMatch(text, CHECK_RE)
  if (check) {
    const word = check[1].toUpperCase()
    return {
      kind: 'check',
      status: word === 'PASS' ? 'pass' : word === 'FAIL' ? 'fail' : 'inconclusive',
    }
  }
  const judge = lastMatch(text, JUDGE_RE)
  if (judge) {
    const verdict = judge[1].replace(/\**\s*$/, '').trim()
    if (verdict) return { kind: 'judge', verdict: verdict.slice(0, 300) }
  }
  return null
}

function lastMatch(text: string, pattern: RegExp): RegExpExecArray | null {
  const all = new RegExp(pattern.source, 'gim')
  let found: RegExpExecArray | null = null
  for (let m = all.exec(text); m; m = all.exec(text)) found = m
  return found
}
