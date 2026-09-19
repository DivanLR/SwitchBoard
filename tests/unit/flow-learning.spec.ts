import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { flowRuleId } from '@shared/domain'
import type { FlowMarker } from '@main/flow/flow-markers'
import { withRule } from '@main/flow/claude-md'

const { openDatabase } = await import('@main/store/db')
const { createRepositories } = await import('@main/store/repositories')
const { FlowSupervisor, MAX_CROSSCHECK_ROUNDS } = await import('@main/flow/flow-supervisor')

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
    }
  }
})

const SCOPE: FlowMarker = {
  kind: 'scope',
  items: [{ localId: 'a', title: 'First', body: 'one', acceptance: [], estimate: 'm' }],
  risks: [],
  outOfScope: [],
}

function setup() {
  const repos = createRepositories(openDatabase(':memory:'))
  const dir = mkdtempSync(join(tmpdir(), 'flow-learn-'))
  dirs.push(dir)
  const project = repos.projects.insert({ name: 'alpha', path: dir, source: 'manual' })
  const sent: { sessionId: string; text: string }[] = []
  let sessionCount = 0
  const manager = {
    startSession: vi.fn(async () => ({ id: `session-${++sessionCount}` })),
    connectedMcpServers: vi.fn(async () => ['ado']),
    sendMessage: (sessionId: string, text: string) => sent.push({ sessionId, text }),
    watchFlow: vi.fn(),
    markSection: vi.fn(),
    renameSession: vi.fn(),
    interruptSession: vi.fn(async () => ({ stillQueued: 0 })),
    workdirFor: () => dir,
  }
  const git = {
    create: vi.fn(async () => ({})),
    dirty: vi.fn(async () => []),
    branch: vi.fn(async () => 'main'),
    root: () => join(dir, '.worktrees'),
  }
  const flow = new FlowSupervisor(repos, manager as never, { onFlowChanged: () => {} }, git)
  return { repos, project, dir, flow, manager, sent }
}

async function crosschecking(harness: ReturnType<typeof setup>) {
  const run = await harness.flow.start({
    projectId: harness.project.id,
    featureId: '4711',
    featureTitle: 'Checkout v2',
  })
  harness.flow.onFlowMarker(run.sessionId!, SCOPE)
  await vi.waitFor(() => expect(harness.repos.flowRuns.byId(run.id)?.status).toBe('crosscheck'), { timeout: 5000 })
  return run
}

describe('the cross-check', () => {
  it('sends the breakdown to a session that did not write it', async () => {
    const harness = setup()
    const run = await crosschecking(harness)

    const reviewer = harness.repos.flowRuns.byId(run.id)!.sessionId
    expect(reviewer).not.toBe(run.sessionId)
    expect(harness.sent.at(-1)!.text).toContain('Another session wrote it; you did not')
  })

  it('carries the reviewer’s notes through to your approval when it approves', async () => {
    const harness = setup()
    const run = await crosschecking(harness)

    harness.flow.onFlowMarker(harness.repos.flowRuns.byId(run.id)!.sessionId!, {
      kind: 'signoff',
      verdict: 'approve',
      concerns: ['the second item leans on an endpoint that does not exist yet'],
      items: null,
    })

    const after = harness.repos.flowRuns.byId(run.id)
    expect(after?.status).toBe('awaiting_approval')
    expect(after?.concerns).toEqual(['the second item leans on an endpoint that does not exist yet'])
    expect(after?.note).toContain('approved it, with notes')
  })

  it('sends a revision back to a scoping session, with the concerns', async () => {
    const harness = setup()
    const run = await crosschecking(harness)

    harness.flow.onFlowMarker(harness.repos.flowRuns.byId(run.id)!.sessionId!, {
      kind: 'signoff',
      verdict: 'revise',
      concerns: ['item two is really half of item one'],
      items: null,
    })
    await vi.waitFor(() => expect(harness.repos.flowRuns.byId(run.id)?.status).toBe('scoping'), { timeout: 5000 })

    expect(harness.repos.flowRuns.byId(run.id)?.crosscheckRound).toBe(1)
    const relay = harness.sent.at(-1)!.text
    expect(relay).toContain('item two is really half of item one')
    expect(relay).toContain('Do not simply agree')
  })

  it('takes a revised list from the reviewer when it supplies one', async () => {
    const harness = setup()
    const run = await crosschecking(harness)

    harness.flow.onFlowMarker(harness.repos.flowRuns.byId(run.id)!.sessionId!, {
      kind: 'signoff',
      verdict: 'revise',
      concerns: ['merge them'],
      items: [{ localId: 'merged', title: 'One item', body: 'both', acceptance: [], estimate: 'l' }],
    })

    expect(harness.repos.flowItems.listForRun(run.id).map((item) => item.localId)).toEqual(['merged'])
  })

  it('stops arguing after the cap and hands the disagreement to you', async () => {
    const harness = setup()
    const run = await crosschecking(harness)

    for (let round = 0; round < MAX_CROSSCHECK_ROUNDS; round += 1) {
      harness.flow.onFlowMarker(harness.repos.flowRuns.byId(run.id)!.sessionId!, {
        kind: 'signoff',
        verdict: 'revise',
        concerns: [`round ${round + 1} concern`],
        items: null,
      })
      if (round + 1 >= MAX_CROSSCHECK_ROUNDS) break
      await vi.waitFor(() => expect(harness.repos.flowRuns.byId(run.id)?.status).toBe('scoping'), { timeout: 5000 })
      harness.flow.onFlowMarker(harness.repos.flowRuns.byId(run.id)!.sessionId!, SCOPE)
      await vi.waitFor(() => expect(harness.repos.flowRuns.byId(run.id)?.status).toBe('crosscheck'), { timeout: 5000 })
    }

    const after = harness.repos.flowRuns.byId(run.id)
    expect(after?.status).toBe('awaiting_approval')
    expect(after?.note).toContain('did not agree')
    expect(after?.concerns).toEqual([`round ${MAX_CROSSCHECK_ROUNDS} concern`])
  })
})

describe('writing a rule into CLAUDE.md', () => {
  it('puts it under the named heading when there is one', () => {
    const current = ['# Project', '', '## Testing', '', '- Run the suite.', '', '## Style', '', '- Tabs.', ''].join('\n')
    const { text, addedLines } = withRule(current, { rule: 'Cover every branch.', section: 'Testing' })

    expect(addedLines).toBe(1)
    const lines = text.split('\n')
    expect(lines.indexOf('- Cover every branch.')).toBeGreaterThan(lines.indexOf('## Testing'))
    expect(lines.indexOf('- Cover every branch.')).toBeLessThan(lines.indexOf('## Style'))
  })

  it('starts a learned section when the heading is unknown, and reuses it after that', () => {
    const first = withRule('# Project\n', { rule: 'Name the work item in the commit.', section: null })
    expect(first.text).toContain('## Learned from review')

    const second = withRule(first.text, { rule: 'Keep migrations append-only.', section: null })
    expect(second.addedLines).toBe(1)
    expect(second.text.match(/## Learned from review/g)).toHaveLength(1)
  })

  it('writes nothing when the rule is already there', () => {
    const current = '# Project\n\n## Learned from review\n\n- Name the work item in the commit.\n'
    const again = withRule(current, { rule: '  Name the work item in the commit.  ', section: null })

    expect(again.addedLines).toBe(0)
    expect(again.text).toBe(current)
  })

  it('creates the file content from nothing', () => {
    const { text, addedLines } = withRule('', { rule: 'Read before you write.', section: null })
    expect(addedLines).toBe(3)
    expect(text).toBe('## Learned from review\n\n- Read before you write.\n')
  })
})

describe('learning from review comments', () => {
  async function withPr() {
    const harness = setup()
    const run = await crosschecking(harness)
    harness.flow.onFlowMarker(harness.repos.flowRuns.byId(run.id)!.sessionId!, {
      kind: 'signoff',
      verdict: 'approve',
      concerns: [],
      items: null,
    })
    await harness.flow.publish(run.id)
    harness.flow.onFlowMarker(harness.repos.flowRuns.byId(run.id)!.sessionId!, {
      kind: 'published',
      created: [{ localId: 'a', workItemId: '5001', url: null }],
      failed: [],
    })
    const item = harness.repos.flowItems.listForRun(run.id)[0]
    harness.repos.flowItems.update(item.id, { status: 'pr_open', prId: '312' })
    return { harness, run }
  }

  it('refuses when no pull request was ever raised', async () => {
    const harness = setup()
    const run = await crosschecking(harness)
    await expect(harness.flow.learn(run.id)).rejects.toMatchObject({ code: 'INVALID_PATH' })
  })

  it('proposes a rule only when it carries the comment it came from', async () => {
    const { harness, run } = await withPr()
    await harness.flow.learn(run.id)

    harness.flow.onFlowMarker(harness.repos.flowRuns.byId(run.id)!.sessionId!, {
      kind: 'lessons',
      lessons: [
        {
          rule: 'Name the work item in every commit message.',
          section: null,
          evidence: [{ prId: '312', author: 'reviewer', quote: 'which work item is this?' }],
        },
      ],
      note: null,
    })

    const lessons = harness.repos.flowLessons.listForProject(harness.project.id)
    expect(lessons).toHaveLength(1)
    expect(lessons[0].evidence[0].quote).toBe('which work item is this?')
    expect(harness.repos.flowRuns.byId(run.id)?.status).toBe('done')
  })

  it('never proposes a rule you rejected before, and says how many it left out', async () => {
    const { harness, run } = await withPr()
    await harness.flow.learn(run.id)
    const rule = 'Name the work item in every commit message.'
    harness.repos.flowLessons.propose({
      projectId: harness.project.id,
      runId: null,
      ruleId: flowRuleId(rule),
      rule,
      section: null,
      evidence: [],
    })
    const stored = harness.repos.flowLessons.listForProject(harness.project.id)[0]
    harness.repos.flowLessons.decide(stored.id, 'rejected', 'we do that in the PR title')

    harness.flow.onFlowMarker(harness.repos.flowRuns.byId(run.id)!.sessionId!, {
      kind: 'lessons',
      lessons: [
        {
          // Same rule, different wording and casing: the identity is the normalised text.
          rule: 'Name the work item in every commit message',
          section: null,
          evidence: [{ prId: '312', author: 'reviewer', quote: 'which work item is this?' }],
        },
      ],
      note: null,
    })

    const lessons = harness.repos.flowLessons.listForProject(harness.project.id)
    expect(lessons.filter((lesson) => lesson.status === 'proposed')).toHaveLength(0)
    expect(harness.repos.flowRuns.byId(run.id)?.note).toContain('left out because you rejected')
  })

  it('writes an accepted rule into CLAUDE.md and reports what it wrote', async () => {
    const { harness, run } = await withPr()
    writeFileSync(join(harness.dir, 'CLAUDE.md'), '# Alpha\n\n## Testing\n\n- Run the suite.\n')
    await harness.flow.learn(run.id)
    harness.flow.onFlowMarker(harness.repos.flowRuns.byId(run.id)!.sessionId!, {
      kind: 'lessons',
      lessons: [
        {
          rule: 'Cover the race in a regression test.',
          section: 'Testing',
          evidence: [{ prId: '312', author: 'reviewer', quote: 'needs a test' }],
        },
      ],
      note: null,
    })
    const lesson = harness.repos.flowLessons.listForProject(harness.project.id)[0]

    const written = await harness.flow.decideLesson(lesson.id, true, null)

    expect(written.appliedLines).toBe(1)
    const text = readFileSync(join(harness.dir, 'CLAUDE.md'), 'utf8')
    expect(text).toContain('- Cover the race in a regression test.')
    expect(harness.repos.flowLessons.byId(lesson.id)?.status).toBe('accepted')
  })

  it('writes nothing when you reject a rule', async () => {
    const { harness, run } = await withPr()
    await harness.flow.learn(run.id)
    harness.flow.onFlowMarker(harness.repos.flowRuns.byId(run.id)!.sessionId!, {
      kind: 'lessons',
      lessons: [
        {
          rule: 'Always use tabs.',
          section: null,
          evidence: [{ prId: '312', author: 'reviewer', quote: 'tabs please' }],
        },
      ],
      note: null,
    })
    const lesson = harness.repos.flowLessons.listForProject(harness.project.id)[0]

    const written = await harness.flow.decideLesson(lesson.id, false, 'we use spaces')

    expect(written.appliedLines).toBe(0)
    expect(written.path).toBeNull()
    expect(harness.repos.flowLessons.byId(lesson.id)?.status).toBe('rejected')
    expect(harness.repos.flowLessons.rejectedRules(harness.project.id)).toEqual(['Always use tabs.'])
  })
})
