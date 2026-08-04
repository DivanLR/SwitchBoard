// The gate's plumbing: a check runs in the session, so its outcome has to be read
// back off that session's own output and written to the acceptance line. Drives
// the real SessionManager scan against a stand-in hosted entry.
import { describe, expect, it } from 'vitest'
import { openDatabase } from '@main/store/db'
import { createRepositories } from '@main/store/repositories'
import { SessionManager } from '@main/sessions/session-manager'
import { checkPrompt } from '@main/evals/eval-dispatch'

function setup() {
  const db = openDatabase(':memory:')
  const repos = createRepositories(db)
  const project = repos.projects.insert({ name: 'a', path: 'C:\\a', source: 'manual' })
  const changed: string[] = []
  const manager = new SessionManager(repos, {
    onEvent: () => {},
    onSessionStatus: () => {},
    onCountersChanged: () => {},
    onSessionExit: () => {},
    onQueueChanged: () => {},
    onEvalsChanged: (projectId) => changed.push(projectId),
    onVerifyChanged: () => {},
    onApiRequests: () => {},
    onApiChanged: () => {},
    onProjectCommands: () => {},
    gate: (async () => ({ behavior: 'allow', updatedInput: {} })) as never,
  })
  const entry = { row: { id: 's1', projectId: project.id } }
  // scanEvalMarker is the private hook both sink paths call; drive it directly.
  const scan = (kind: string, payload: unknown): void =>
    (manager as unknown as { scanEvalMarker(e: unknown, k: string, p: unknown): void }).scanEvalMarker(
      entry,
      kind,
      payload,
    )
  // What handleStatusChange('done'/'error') and handleExit call when the turn is
  // over — the point at which an unreported watch must stop listening.
  const endTurn = (): void =>
    (manager as unknown as { closeUnreportedEval(e: unknown): void }).closeUnreportedEval(entry)
  return { repos, manager, projectId: project.id, changed, scan, endTurn }
}

describe('verifier gate watch', () => {
  it('writes the reported outcome onto the watched line and announces it', () => {
    const { repos, manager, projectId, changed, scan } = setup()
    const run = repos.evals.add(projectId, 'the bar shows', 'npm test')
    manager.watchEvalMarker('s1', run.id, 'check')

    scan('assistant_text', { text: 'Ran it.\nEVAL_CHECK: PASS' })
    expect(repos.evals.byId(run.id)?.checkStatus).toBe('pass')
    expect(changed).toEqual([projectId])
  })

  it('ignores the prompt event, so the instruction is never read as the answer', () => {
    const { repos, manager, projectId, scan } = setup()
    const run = repos.evals.add(projectId, 'the bar shows', 'npm test')
    manager.watchEvalMarker('s1', run.id, 'check')

    // The dispatch prompt names every sentinel — it must not count as a result.
    scan('prompt', { text: checkPrompt('the bar shows', 'npm test') })
    expect(repos.evals.byId(run.id)?.checkStatus).toBe('not_run')
  })

  it('does nothing without a watch, and stops after the first result', () => {
    const { repos, projectId, scan, manager } = setup()
    const run = repos.evals.add(projectId, 'the bar shows', 'npm test')

    scan('assistant_text', { text: 'EVAL_CHECK: PASS' })
    expect(repos.evals.byId(run.id)?.checkStatus).toBe('not_run')

    manager.watchEvalMarker('s1', run.id, 'check')
    scan('assistant_text', { text: 'EVAL_CHECK: FAIL' })
    expect(repos.evals.byId(run.id)?.checkStatus).toBe('fail')
    // A later turn talking about checks must not overwrite the recorded result.
    scan('assistant_text', { text: 'EVAL_CHECK: PASS' })
    expect(repos.evals.byId(run.id)?.checkStatus).toBe('fail')
  })

  it('stops listening when the turn ends without a result line', () => {
    const { repos, manager, projectId, scan, endTurn } = setup()
    const run = repos.evals.add(projectId, 'the bar shows', 'npm test')
    manager.watchEvalMarker('s1', run.id, 'check')

    // The turn finished and said nothing about the check, so the line stays
    // unverified — which is the honest outcome, and the whole point of FR-047.
    endTurn()
    expect(repos.evals.byId(run.id)?.checkStatus).toBe('not_run')

    // A later, unrelated turn mentions a check. Before the watch was closed here
    // it was still listening, so this stamped PASS onto a line nobody re-ran.
    scan('assistant_text', { text: 'EVAL_CHECK: PASS' })
    expect(repos.evals.byId(run.id)?.checkStatus).toBe('not_run')
  })

  it('keeps a result that already arrived, even though the turn then ends', () => {
    const { repos, manager, projectId, scan, endTurn } = setup()
    const run = repos.evals.add(projectId, 'the bar shows', 'npm test')
    manager.watchEvalMarker('s1', run.id, 'check')

    // The marker lands during the turn (the sink appends before the status
    // change), so closing the watch afterwards must not undo it.
    scan('assistant_text', { text: 'EVAL_CHECK: PASS' })
    endTurn()
    expect(repos.evals.byId(run.id)?.checkStatus).toBe('pass')
  })

  it('keeps a check watch from swallowing a judge line, and the reverse', () => {
    const { repos, manager, projectId, scan } = setup()
    const run = repos.evals.add(projectId, 'the bar shows', 'npm test')

    manager.watchEvalMarker('s1', run.id, 'check')
    scan('assistant_text', { text: 'EVAL_JUDGE: looks thin on the error path' })
    expect(repos.evals.byId(run.id)?.judge).toBeNull()

    manager.watchEvalMarker('s1', run.id, 'judge')
    scan('summary', { text: 'EVAL_JUDGE: looks thin on the error path' })
    expect(repos.evals.byId(run.id)?.judge).toBe('looks thin on the error path')
    expect(repos.evals.byId(run.id)?.checkStatus).toBe('not_run')
  })
})
