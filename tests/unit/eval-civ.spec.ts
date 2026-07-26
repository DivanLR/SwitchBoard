// The Coordinator-Implementor-Verifier parts of the eval loop: which suites a
// project can run, the marker that carries a check's real outcome back out of the
// session, the gate that stops a false pass, and the derived stage.
import { describe, expect, it } from 'vitest'
import { canPassEval, evalStage, type EvalRun } from '@shared/domain'
import { detectStacks, TEST_STACKS } from '@shared/test-catalog'
import {
  attemptsPrompt,
  checkPrompt,
  judgePrompt,
  parseEvalMarker,
} from '@main/evals/eval-dispatch'

const line = (over: Partial<EvalRun> = {}): EvalRun => ({
  id: 'e1',
  projectId: 'p1',
  acceptance: 'the button shows a bar',
  checkCmd: 'npm test',
  checkStatus: 'not_run',
  verdict: 'pending',
  rating: null,
  note: null,
  attempts: 1,
  judge: null,
  createdAt: '2026-07-26T00:00:00.000Z',
  ...over,
})

describe('stack detection', () => {
  it('reports every stack present, so an API and its front end both get suites', () => {
    const found = detectStacks(['MyApi.sln', 'angular.json', 'README.md'])
    expect(found.map((s) => s.stackId)).toEqual(['dotnet', 'angular'])
  })

  it('matches an extension pattern anywhere in the root, case-insensitively', () => {
    expect(detectStacks(['Thing.SLNX']).map((s) => s.stackId)).toEqual(['dotnet'])
    expect(detectStacks(['notes.txt'])).toEqual([])
  })

  it('offers API, UI and unit coverage for every stack it knows', () => {
    for (const stack of TEST_STACKS) {
      const kinds = new Set(stack.suites.map((s) => s.kind))
      expect(kinds.has('unit'), `${stack.id} has unit`).toBe(true)
      expect(kinds.has('api') || kinds.has('ui'), `${stack.id} has api or ui`).toBe(true)
      // Every suite must carry both halves: what it proves, and how.
      for (const suite of stack.suites) {
        expect(suite.acceptance.length, `${suite.id} acceptance`).toBeGreaterThan(10)
        expect(suite.command.length, `${suite.id} command`).toBeGreaterThan(3)
      }
    }
  })
})

describe('check marker', () => {
  it('reads the reported outcome', () => {
    expect(parseEvalMarker('all good\nEVAL_CHECK: PASS')).toEqual({ kind: 'check', status: 'pass' })
    expect(parseEvalMarker('EVAL_CHECK: FAIL')).toEqual({ kind: 'check', status: 'fail' })
    expect(parseEvalMarker('EVAL_CHECK: INCONCLUSIVE')).toEqual({
      kind: 'check',
      status: 'inconclusive',
    })
  })

  it('survives markdown emphasis around the marker', () => {
    expect(parseEvalMarker('**EVAL_CHECK**: **PASS**')).toEqual({ kind: 'check', status: 'pass' })
  })

  it('takes the LAST marker, so an echoed instruction cannot pass as the answer', () => {
    const echoed = `${checkPrompt('a line', 'npm test')}\n\nRan it.\nEVAL_CHECK: FAIL`
    expect(parseEvalMarker(echoed)).toEqual({ kind: 'check', status: 'fail' })
  })

  it('reports nothing when the session said nothing readable', () => {
    expect(parseEvalMarker('I ran the tests and they seem fine')).toBeNull()
    expect(parseEvalMarker('EVAL_CHECK: probably ok')).toBeNull()
    expect(parseEvalMarker('')).toBeNull()
  })

  it('reads a judge verdict and caps its length', () => {
    expect(parseEvalMarker('EVAL_JUDGE: satisfies the line, but nothing covers the error path')).toEqual({
      kind: 'judge',
      verdict: 'satisfies the line, but nothing covers the error path',
    })
    const long = parseEvalMarker(`EVAL_JUDGE: ${'x'.repeat(500)}`)
    expect(long?.kind === 'judge' && long.verdict.length).toBe(300)
  })
})

describe('dispatch prompts', () => {
  it('tells the session to report the real outcome and not to fix anything', () => {
    const prompt = checkPrompt('the bar shows', 'npx vitest run x')
    expect(prompt).toContain('npx vitest run x')
    expect(prompt).toContain('do not edit files')
    expect(prompt).toContain('EVAL_CHECK: PASS')
  })

  it('asks for isolated parallel attempts and forbids merging without asking', () => {
    const prompt = attemptsPrompt('the bar shows', 'npm test', 3)
    expect(prompt).toContain('3 INDEPENDENT attempts')
    expect(prompt).toContain('git worktree')
    expect(prompt).toContain('do not merge')
  })

  it('sends the judge to the advisor so it is a second opinion', () => {
    expect(judgePrompt('the bar shows')).toContain('`advisor`')
    expect(judgePrompt('the bar shows')).toContain('Do not change any code')
  })
})

describe('the verifier gate', () => {
  it('blocks a pass until the check has passed', () => {
    expect(canPassEval(line({ checkStatus: 'not_run' }))).toBe(false)
    expect(canPassEval(line({ checkStatus: 'fail' }))).toBe(false)
    expect(canPassEval(line({ checkStatus: 'inconclusive' }))).toBe(false)
    expect(canPassEval(line({ checkStatus: 'pass' }))).toBe(true)
  })

  it('does not block a line that has no check — the manual pass is its gate', () => {
    expect(canPassEval(line({ checkCmd: null }))).toBe(true)
  })
})

describe('derived stage', () => {
  it('walks implement → verify → review → done', () => {
    expect(evalStage(line())).toBe('implement')
    expect(evalStage(line({ checkStatus: 'pass' }))).toBe('verify')
    expect(evalStage(line({ checkStatus: 'pass', judge: 'looks right' }))).toBe('review')
    expect(evalStage(line({ checkStatus: 'pass', judge: 'looks right', verdict: 'pass' }))).toBe('done')
  })

  it('is done once the developer has ruled, even on a failure', () => {
    expect(evalStage(line({ verdict: 'fail' }))).toBe('done')
  })
})
