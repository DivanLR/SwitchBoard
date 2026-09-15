import type { EvalCheckStatus } from '@shared/domain'

const CHECK_MARKER = 'EVAL_CHECK'
const JUDGE_MARKER = 'EVAL_JUDGE'

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

export function judgePrompt(acceptance: string): string {
  return (
    `Judge the current diff against this acceptance line: "${acceptance}"\n\n` +
    'Use the `advisor` subagent so this is a second opinion, not the same reasoning again. ' +
    'Answer: does the diff actually satisfy the line, what is the strongest reason it might ' +
    'not, and what is untested. Do not change any code.\n' +
    `Finish with one line, on its own: ${JUDGE_MARKER}: <verdict in under 20 words>`
  )
}

type EvalMarker =
  | { kind: 'check'; status: EvalCheckStatus }
  | { kind: 'judge'; verdict: string }

const CHECK_RE = new RegExp(`^\\s*\\**${CHECK_MARKER}\\**\\s*:\\s*\\**\\s*(PASS|FAIL|INCONCLUSIVE)`, 'im')
const JUDGE_RE = new RegExp(`^\\s*\\**${JUDGE_MARKER}\\**\\s*:\\s*(.+)$`, 'im')

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
