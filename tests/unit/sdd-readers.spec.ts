import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  installExtension,
  installSpecKit,
  pinSpec,
  readConstitutionState,
  readSddEntries,
  readSddReport,
  readSpecDetail,
  readSpecKitState,
  type CommandRunner,
} from '@main/specs/spec-kit'
import { bugResultOf, decisionOf, handoffOf, sddCommand, sddSlug } from '@shared/sdd'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function project(): string {
  const d = mkdtempSync(join(tmpdir(), 'sdd-'))
  dirs.push(d)
  mkdirSync(join(d, '.specify', 'memory'), { recursive: true })
  return d
}

function write(root: string, rel: string, text: string): void {
  const full = join(root, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, text)
}

describe('readSpecDetail', () => {
  it('reads sections, clarifications, phases and the converge state', async () => {
    const p = project()
    write(
      p,
      'specs/003-orders/spec.md',
      [
        '# Feature Specification: Orders',
        '',
        '## Summary',
        'Let a customer place an order.',
        '',
        '## Requirements',
        '- FR-001 MUST total the basket [NEEDS CLARIFICATION: tax rules?]',
        '',
        '## Clarifications',
        '- Q: Which currency? → A: Rand only',
      ].join('\n'),
    )
    write(p, 'specs/003-orders/plan.md', '# Plan\n\n## Approach\nA handler.\n')
    write(
      p,
      'specs/003-orders/tasks.md',
      [
        '## Phase 1: Build',
        '- [x] T001 Add the handler',
        '## Phase 2: Convergence',
        '- [x] T002 Wire the endpoint',
        '## Phase 3: Convergence',
        '- [ ] T003 Validate the basket',
      ].join('\r\n'),
    )
    const detail = await readSpecDetail(p, '003-orders')
    expect(detail?.title).toBe('Orders')
    expect(detail?.description).toBe('Let a customer place an order.')
    expect(detail?.sections.map((s) => s.title)).toEqual(['Summary', 'Requirements', 'Clarifications'])
    expect(detail?.plan.map((s) => s.title)).toEqual(['Approach'])
    expect(detail?.clarifications).toEqual(['tax rules?'])
    expect(detail?.resolvedClarifications).toEqual([{ question: 'Which currency?', answer: 'Rand only' }])
    expect(detail?.tasksDone).toBe(2)
    expect(detail?.tasksTotal).toBe(3)
    expect(detail?.convergence).toEqual({ rounds: 2, open: 1 })
  })

  it('refuses an id that walks out of specs/', async () => {
    const p = project()
    expect(await readSpecDetail(p, '..')).toBeNull()
    expect(await readSpecDetail(p, '../x')).toBeNull()
  })
})

describe('readConstitutionState', () => {
  it('tells missing, template and written apart', async () => {
    const p = project()
    expect(await readConstitutionState(p)).toBe('missing')
    write(p, '.specify/memory/constitution.md', '# [PROJECT_NAME] Constitution\n### [PRINCIPLE_1_NAME]\n')
    expect(await readConstitutionState(p)).toBe('template')
    write(p, '.specify/memory/constitution.md', '# Shop Constitution\n### I. Tests first\n')
    expect(await readConstitutionState(p)).toBe('written')
  })
})

describe('readSddEntries', () => {
  it('reads each bug with its reports, severity and final verdict', async () => {
    const p = project()
    write(p, '.specify/bugs/login-timeout/assessment.md', '# Bug Assessment: Login times out\n\n- **Severity**: high\n')
    write(p, '.specify/bugs/login-timeout/fix.md', '# Fix\n')
    write(p, '.specify/bugs/login-timeout/test.md', '# Test\n\n- **Result**: partial\n')
    write(p, '.specify/bugs/cart-empty/assessment.md', '# Bug Assessment: Cart empties\n\n- **Severity**: low\n')
    write(p, '.specify/bugs/Not A Slug/assessment.md', '# ignored\n')
    const bugs = await readSddEntries(p, 'bug')
    expect(bugs).toEqual([
      { slug: 'cart-empty', title: 'Cart empties', files: ['assessment.md'], verdict: null, severity: 'low' },
      {
        slug: 'login-timeout',
        title: 'Login times out',
        files: ['assessment.md', 'fix.md', 'test.md'],
        verdict: 'partial',
        severity: 'high',
      },
    ])
  })

  it('reads each idea with the decision', async () => {
    const p = project()
    write(p, '.specify/assessments/offline-mode/intake.md', '# Idea Intake: Offline mode\n')
    write(p, '.specify/assessments/offline-mode/decision.md', '# Decision\n\n- **Verdict**: go\n')
    const ideas = await readSddEntries(p, 'assess')
    expect(ideas).toEqual([
      { slug: 'offline-mode', title: 'Offline mode', files: ['intake.md', 'decision.md'], verdict: 'go', severity: null },
    ])
  })
})

describe('readSddReport', () => {
  it('reads a named report and refuses anything else', async () => {
    const p = project()
    write(p, '.specify/bugs/a-bug/test.md', '- **Result**: verified\n')
    expect(await readSddReport(p, 'bug', 'a-bug', 'test.md')).toEqual({
      path: '.specify/bugs/a-bug/test.md',
      content: '- **Result**: verified\n',
    })
    expect(await readSddReport(p, 'bug', 'a-bug', '../../../secret.md')).toBeNull()
    expect(await readSddReport(p, 'bug', '../x', 'test.md')).toBeNull()
    expect(await readSddReport(p, 'bug', 'a-bug', 'fix.md')).toBeNull()
  })
})

describe('readSpecKitState', () => {
  it('reports the constitution, bugs, ideas and which extensions are installed', async () => {
    const p = project()
    write(p, '.specify/extensions/bug/extension.yml', 'id: bug\n')
    write(p, '.specify/bugs/x/assessment.md', '# X\n')
    const state = await readSpecKitState(p)
    expect(state.constitution).toBe('missing')
    expect(state.extensions).toEqual({ bug: true, assess: false })
    expect(state.bugs.map((b) => b.slug)).toEqual(['x'])
    expect(state.ideas).toEqual([])
  })
})

describe('installExtension', () => {
  it('runs extension add through the same pinned Spec Kit as init, never an older specify on PATH', async () => {
    const p = project()
    const run = vi.fn<CommandRunner>(async (_file, _args, cwd) => {
      write(cwd, '.specify/extensions/assess/extension.yml', 'id: assess\n')
      return { code: 0, missing: false, output: 'Extension installed successfully!' }
    })
    await installExtension(p, 'assess', run)
    expect(run).toHaveBeenCalledWith(
      'uvx',
      ['--from', 'git+https://github.com/github/spec-kit.git', 'specify', 'extension', 'add', 'assess'],
      p,
    )
  })

  it('reports the CLI’s own error plainly when the add fails', async () => {
    const p = project()
    const run: CommandRunner = async () => ({
      code: 1,
      missing: false,
      output:
        "Error: Extension 'bug' is bundled with spec-kit but could not be found in the \ninstalled package.\n\nTry reinstalling spec-kit:\n  uv tool install specify-cli --force",
    })
    await expect(installExtension(p, 'bug', run)).rejects.toEqual({
      code: 'INTERNAL',
      message:
        "specify extension add bug failed with exit code 1: Extension 'bug' is bundled with spec-kit but could not be found in the installed package. Try reinstalling spec-kit: uv tool install specify-cli --force",
    })
  })

  it('fails when the command exits cleanly but installed nothing', async () => {
    const p = project()
    const run: CommandRunner = async () => ({ code: 0, missing: false, output: '' })
    await expect(installExtension(p, 'bug', run)).rejects.toMatchObject({ code: 'INTERNAL' })
  })

  it('says the CLI is missing, and refuses a project without Spec Kit', async () => {
    const p = project()
    const missing: CommandRunner = async () => ({ code: null, missing: true, output: 'spawn specify ENOENT' })
    await expect(installExtension(p, 'bug', missing)).rejects.toMatchObject({ code: 'UNSUPPORTED' })
    const bare = mkdtempSync(join(tmpdir(), 'sdd-bare-'))
    dirs.push(bare)
    const run = vi.fn<CommandRunner>()
    await expect(installExtension(bare, 'bug', run)).rejects.toMatchObject({ code: 'UNSUPPORTED' })
    expect(run).not.toHaveBeenCalled()
  })
})

describe('pinSpec', () => {
  it('points feature.json at the spec the SDD tab selected, keeps its other keys, and refuses a spec that is not there', async () => {
    const p = project()
    write(p, 'specs/001-login/spec.md', '# Login\n')
    write(p, '.specify/feature.json', JSON.stringify({ feature_directory: 'specs/002-export', numbering: 'sequential' }))

    await pinSpec(p, '001-login')

    expect(JSON.parse(readFileSync(join(p, '.specify', 'feature.json'), 'utf8'))).toEqual({
      feature_directory: 'specs/001-login',
      numbering: 'sequential',
    })
    await expect(pinSpec(p, '..')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(pinSpec(p, '003-none')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('installSpecKit', () => {
  it('runs specify init through uvx and checks .specify appeared', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'sdd-init-'))
    dirs.push(bare)
    const run = vi.fn<CommandRunner>(async (_file, _args, cwd) => {
      mkdirSync(join(cwd, '.specify'))
      return { code: 0, missing: false, output: '' }
    })
    await installSpecKit(bare, run)
    expect(run.mock.calls[0][0]).toBe('uvx')
    expect(run.mock.calls[0][1]).toEqual(expect.arrayContaining(['specify', 'init', '--here', '--integration', 'claude']))
  })
})

describe('sdd helpers', () => {
  it('builds commands and slugs the way the extensions read them', () => {
    expect(sddCommand('speckit-bug-assess', 'Login "hangs"', 'login-hangs')).toBe(
      `/speckit-bug-assess "Login 'hangs'" slug=login-hangs`,
    )
    expect(sddCommand('speckit-bug-fix', '', 'login-hangs')).toBe('/speckit-bug-fix slug=login-hangs')
    expect(sddSlug('  Login times out after 30s!  ')).toBe('login-times-out-after-30s')
    expect(sddSlug('!!!')).toBe('untitled')
  })

  it('reads the verdict fields and the go handoff', () => {
    expect(bugResultOf('- **Result**: verified | partial | failed')).toBe('verified')
    expect(bugResultOf('- **Result**: not-run')).toBeNull()
    expect(bugResultOf(null)).toBeNull()
    expect(decisionOf('- **Verdict**: needs-clarification')).toBe('needs-clarification')
    const decision = ['# Decision', '', '## If go — Handoff to `/speckit-specify`', '', 'Build offline sync.', '', '## Next'].join('\n')
    expect(handoffOf(decision)).toBe('Build offline sync.')
    expect(handoffOf('# Decision\n')).toBeNull()
  })
})
