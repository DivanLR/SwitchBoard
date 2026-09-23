import { describe, expect, it } from 'vitest'
import { emptyVerifyReport } from '@shared/domain'
import {
  buildSteps,
  cleanSteps,
  fixFindingsPrompt,
  planHandshake,
  planSteps,
  reviewHandshake,
  reviewSteps,
  revisePrompt,
  shipPrompt,
  testWritePrompt,
} from '@main/flow/flow-prompts'

describe('the fix prompt, sent to a fresh session', () => {
  const report = {
    findings: [
      { severity: 'must_fix' as const, file: 'Cart.cs', line: 12, what: 'Off-by-one in the total.' },
      { severity: 'must_fix' as const, file: null, line: null, what: 'No test covers the empty cart.' },
      { severity: 'should_fix' as const, file: 'Cart.cs', line: 40, what: 'Extract the rounding.' },
    ],
    unmet: ['A guest can pay without an account.'],
  }

  it('carries every must_fix finding with its location and every unmet criterion', () => {
    const prompt = fixFindingsPrompt(report, { baseBranch: 'develop', specDir: 'specs/002-cart' })
    expect(prompt).toContain('against develop')
    expect(prompt).toContain('- Cart.cs:12: Off-by-one in the total.')
    expect(prompt).toContain('- No test covers the empty cart.')
    expect(prompt).toContain('- A guest can pay without an account.')
    expect(prompt).toContain('specs/002-cart/spec.md')
    expect(prompt).not.toContain('Extract the rounding.')
  })

  it('still reads on its own without a stored report', () => {
    expect(fixFindingsPrompt(null, { baseBranch: null, specDir: null })).toContain('the base branch')
  })
})

describe('the revise prompt, sent to a fresh session', () => {
  const run = { specDir: 'specs/002-cart', prUrl: 'https://dev.azure.com/x/_git/y/pullrequest/9', baseBranch: 'main' }

  it('names the artefact file and the feedback', () => {
    const prompt = revisePrompt(run, 'plan', 'Split the migration into its own task.')
    expect(prompt).toContain('Revise the plan and its tasks (specs/002-cart/plan.md) per this feedback')
    expect(prompt).toContain('Split the migration into its own task.')
  })

  it('points a stage without an artefact file at the spec and the base branch', () => {
    const prompt = revisePrompt(run, 'build', 'Use the existing money type.')
    expect(prompt).toContain('the implementation on this branch')
    expect(prompt).toContain('specs/002-cart/spec.md')
    expect(prompt).toContain('against main')
  })

  it('names the pull request for the ship stage', () => {
    expect(revisePrompt(run, 'ship', 'Mention the migration.')).toContain(run.prUrl)
  })
})

describe('the plan steps', () => {
  it('name the spec folder in every Spec Kit command, each starting with its slash command', () => {
    const steps = planSteps(['dotnet'], 'specs/005-invoices')
    expect(steps.map((step) => step.split(' ')[0])).toEqual(['/speckit-plan', '/speckit-tasks', '/speckit-analyze'])
    for (const step of steps) expect(step).toContain('specs/005-invoices')
  })

  it('ask the handshake to report blocked with the CRITICAL analyze issues', () => {
    expect(planHandshake()).toContain('CRITICAL issue, the outcome is blocked')
  })
})

describe('the build steps', () => {
  it('scaffolds .NET only for a dotnet-only run', () => {
    const steps = buildSteps(['dotnet'], 'specs/001-cart')
    expect(steps).toHaveLength(1)
    expect(steps[0].startsWith('/speckit-implement-scaffold ')).toBe(true)
  })

  it('implements everything for an angular-only run', () => {
    const steps = buildSteps(['angular'], null)
    expect(steps).toHaveLength(1)
    expect(steps[0].startsWith('/speckit-implement ')).toBe(true)
    expect(steps[0]).not.toContain('still unchecked')
  })

  it('scaffolds .NET then finishes the remaining tasks for a mixed run', () => {
    const steps = buildSteps(['dotnet', 'angular'], null)
    expect(steps[0].startsWith('/speckit-implement-scaffold ')).toBe(true)
    expect(steps[1].startsWith('/speckit-implement Complete every task still unchecked in tasks.md.')).toBe(true)
  })

  it('tells each implement skill the run is unattended, names the spec folder and carries the conventions', () => {
    for (const step of buildSteps(['dotnet', 'angular'], 'specs/001-cart')) {
      expect(step).toContain('unattended')
      expect(step).toContain('if a checklist is incomplete, proceed and list the open items')
      expect(step).toContain('use the one plan.md names')
      expect(step).toContain('how many tasks are done and the total')
      expect(step).toContain('specs/001-cart')
      expect(step).toContain('IOptionsMonitor for feature flags')
      expect(step).toContain('OnPush')
    }
  })
})

describe('the clean steps', () => {
  it('runs de-sloppify before ponytail for .NET, told to create no issues and add no comments', () => {
    const steps = cleanSteps(['dotnet'], 'main')
    expect(steps[0].startsWith('/dotnet-claude-kit:de-sloppify ')).toBe(true)
    expect(steps[0]).toContain('against main')
    expect(steps[0]).toContain('Skip the step that creates issues')
    expect(steps[0]).toContain('resolve or delete each TODO')
    expect(steps[0]).toContain('Add no comments.')
    expect(steps[1].startsWith('/ponytail:ponytail-review ')).toBe(true)
    expect(steps[2]).not.toContain('lint')
  })

  it('lists with ponytail-review, then applies the safe findings in a plain follow-up that tests and commits', () => {
    const steps = cleanSteps(['angular'], 'develop')
    expect(steps).toHaveLength(2)
    expect(steps[0]).toBe('/ponytail:ponytail-review Review the diff of this branch against develop.')
    expect(steps[1].startsWith('/')).toBe(false)
    expect(steps[1]).toContain('Apply every finding from that review that is safe')
    expect(steps[1]).toContain('lint script with --fix')
    expect(steps[1]).toContain('Run the tests')
    expect(steps[1]).toContain('commit the result')
  })

  it('runs all three for a mixed run', () => {
    const steps = cleanSteps(['dotnet', 'angular'], 'main')
    expect(steps).toHaveLength(3)
    expect(steps[2]).toContain('lint script with --fix')
  })
})

describe('the test-writing prompt', () => {
  it('mentions only the stack sections that apply', () => {
    const dotnetOnly = testWritePrompt({ specDir: 'specs/1-x' }, ['dotnet'])
    expect(dotnetOnly).toContain('xUnit')
    expect(dotnetOnly).not.toContain('Karma/Jasmine')

    const angularOnly = testWritePrompt({ specDir: 'specs/1-x' }, ['angular'])
    expect(angularOnly).toContain('Karma/Jasmine')
    expect(angularOnly).not.toContain('xUnit')
  })

  it('always covers the API/Postman case, pointed at the spec folder', () => {
    const prompt = testWritePrompt({ specDir: 'specs/2-cart' }, ['dotnet'])
    expect(prompt).toContain('specs/2-cart/postman')
    expect(prompt).toContain('postman_collection.json')
  })
})

describe('the review steps', () => {
  it('runs the dotnet-claude-kit code review and security scan for .NET', () => {
    const steps = reviewSteps(['dotnet'], 'main')
    expect(steps).toEqual([
      '/dotnet-claude-kit:code-review Review the changes on this branch against main.',
      '/dotnet-claude-kit:security-scan Scope: the changes on this branch against main.',
    ])
  })

  it('has no dotnet-specific steps for angular-only, leaving it to the handshake turn', () => {
    expect(reviewSteps(['angular'], 'main')).toEqual([])
  })

  it('checks the conventions and the named spec, and keeps a completed review done whatever it found', () => {
    const prompt = reviewHandshake('main', 'specs/001-cart', ['dotnet'])
    expect(prompt).toContain('specs/001-cart/spec.md')
    expect(prompt).toContain('every violation is a must_fix finding')
    expect(prompt).toContain('IOptionsMonitor for feature flags')
    expect(prompt).toContain('Every Critical or High security finding is a must_fix finding.')
    expect(prompt).toContain('The outcome is done whenever you completed the review')
  })
})

describe('the ship prompt', () => {
  it('links the Azure DevOps work item when the source was ado', () => {
    const prompt = shipPrompt({
      title: 'Checkout v2',
      branch: 'feature/checkout-v2',
      baseBranch: 'main',
      source: 'ado',
      sourceRef: '4711',
    })
    expect(prompt).toContain('link Azure DevOps work item 4711')
    expect(prompt).toContain('Do not merge, approve, or add reviewers.')
  })

  it('carries the stored test report figures and the Postman path, and says so when there is no report', () => {
    const run = { title: 'Cart', branch: 'feature/cart', baseBranch: 'main', source: 'text' as const, sourceRef: null }
    const verify = {
      ...emptyVerifyReport(),
      suites: [{ id: 'dotnet-unit', label: 'Unit tests', status: 'pass' as const, detail: '42 passed' }],
    }
    verify.coverage.line = { value: 81, source: 'coverage.cobertura.xml' }
    const prompt = shipPrompt(run, { verify, postman: 'specs/001-cart/postman/cart.postman_collection.json' })
    expect(prompt).toContain('- dotnet-unit (Unit tests): pass, 42 passed')
    expect(prompt).toContain('- Line coverage: 81% (coverage.cobertura.xml)')
    expect(prompt).not.toContain('Changed-line coverage')
    expect(prompt).toContain('Postman collection: specs/001-cart/postman/cart.postman_collection.json')

    expect(shipPrompt(run, { verify: null, postman: null })).toContain('The Test stage left no report')
  })

  it('never mentions a work item for a text source', () => {
    const prompt = shipPrompt({
      title: 'Checkout v2',
      branch: 'feature/checkout-v2',
      baseBranch: 'main',
      source: 'text',
      sourceRef: null,
    })
    expect(prompt).not.toContain('link Azure DevOps work item')
  })
})
