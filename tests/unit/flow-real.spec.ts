import { describe, expect, it, vi } from 'vitest'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { FlowRun, FlowStageStatus } from '@shared/domain'
import type { FlowStartSource } from '@shared/ipc-types'
import { openDatabase } from '@main/store/db'
import { createRepositories } from '@main/store/repositories'
import { SessionManager } from '@main/sessions/session-manager'
import { FlowSupervisor } from '@main/flow/flow-supervisor'

const enabled = process.env.REAL_SESSION === '1'

const SPEC_WAIT = { timeout: 15 * 60_000, interval: 2_000 }

const CSPROJ = [
  '<Project Sdk="Microsoft.NET.Sdk.Web">',
  '  <PropertyGroup>',
  '    <TargetFramework>net10.0</TargetFramework>',
  '  </PropertyGroup>',
  '</Project>',
  '',
].join('\n')

const ANGULAR_JSON = '{"version":1,"projects":{"health-web":{"projectType":"application","root":"","sourceRoot":"src"}}}\n'

function gitRepo(root: string, name: string, file: string, content: string): string {
  const repo = join(root, name)
  mkdirSync(repo)
  writeFileSync(join(repo, file), content)
  execSync('git init', { cwd: repo })
  execSync(`git add ${file}`, { cwd: repo })
  execSync('git -c user.name=Switchboard -c user.email=flow-smoke@example.invalid commit -m "Initial commit"', {
    cwd: repo,
  })
  return repo
}

async function specStageSmoke(
  layout: (root: string) => string[],
  source: FlowStartSource,
  check: (run: FlowRun, spec: string) => void,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'switchboard-flow-'))
  const [primary, ...companions] = layout(root)

  const db = openDatabase(':memory:')
  const repos = createRepositories(db)
  const project = repos.projects.insert({ name: basename(primary), path: primary, source: 'manual' })
  const others = companions.map((path) => ({
    projectId: repos.projects.insert({ name: basename(path), path, source: 'manual' }).id,
  }))

  const manager = new SessionManager(repos, {
    onEvent: () => {},
    onSessionStatus: () => {},
    onCountersChanged: () => {},
    onSessionExit: () => {},
    onQueueChanged: () => {},
    onVerifyChanged: () => {},
    onDiagramsChanged: () => {},
    onProjectCommands: () => {},
    gate: async (context) => ({ behavior: 'allow', updatedInput: context.input }),
  })

  const seen = new Set<FlowStageStatus>()
  let runId = ''
  let holding = false
  const flow = new FlowSupervisor(repos, manager, {
    onFlowChanged: () => {
      const status = runId ? repos.flowStages.get(runId, 'spec')?.status : undefined
      if (status) seen.add(status)
      if (status === 'review' && !holding) {
        holding = true
        flow.setAutopilot(runId, false)
      }
    },
  })
  manager.setFlowHooks({
    onMarker: (sessionId, marker) => flow.onFlowMarker(sessionId, marker),
    onSessionEnded: (sessionId, reason) => flow.onSessionEnded(sessionId, reason),
    onVerifyReport: (sessionId, report) => flow.onVerifyReport(sessionId, report),
    onTurnEnded: (sessionId, error) => flow.onTurnEnded(sessionId, error),
  })

  try {
    const run = await flow.start({ projectId: project.id, source, autopilot: true, autoShip: false, companions: others })
    runId = run.id

    await vi.waitFor(() => {
      const status = repos.flowStages.get(runId, 'spec')?.status
      expect(seen.has('review') || status === 'failed').toBe(true)
    }, SPEC_WAIT)

    const spec = repos.flowStages.get(runId, 'spec')
    expect(seen.has('review'), spec?.summary ?? 'the spec stage failed').toBe(true)
    const after = repos.flowRuns.byId(runId)!
    expect(after.worktreePath).not.toBeNull()
    expect(after.specDir).not.toBeNull()
    const specPath = join(after.worktreePath!, after.specDir!, 'spec.md')
    console.log(`spec stage: ${spec?.status} · ${spec?.summary} · ${specPath}`)
    const text = existsSync(specPath) ? readFileSync(specPath, 'utf8') : ''
    console.log(text.slice(0, 1200))
    expect(existsSync(specPath)).toBe(true)
    expect(after.stage).toBe('spec')
    check(after, text)
  } finally {
    if (runId) {
      await flow.cancel(runId).catch(() => {})
      await flow.removeWorktree(runId, true).catch(() => {})
    }
    await manager.endAllForAppExit()
    db.close()
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
    } catch {}
  }
}

describe.runIf(enabled)('a real Flow run (spec stage smoke)', () => {
  it(
    'specifies a small feature in its own worktree and holds it at review',
    () =>
      specStageSmoke(
        (root) => [gitRepo(root, 'health-api', 'HealthApi.csproj', CSPROJ)],
        { kind: 'text', title: 'Health endpoint', description: 'Add a GET /health endpoint that returns ok' },
        () => {},
      ),
    20 * 60_000,
  )

  it(
    'specifies a feature across an API and a front end, in a worktree each, and names both repositories',
    () =>
      specStageSmoke(
        (root) => [
          gitRepo(root, 'health-api', 'HealthApi.csproj', CSPROJ),
          gitRepo(root, 'health-web', 'angular.json', ANGULAR_JSON),
        ],
        {
          kind: 'text',
          title: 'Health status page',
          description: 'Add a GET /health endpoint to the API and show its result on the home page of the front end',
        },
        (run, spec) => {
          expect(run.repos.map((repo) => repo.name)).toEqual(['health-api', 'health-web'])
          expect(run.repos.every((repo) => repo.worktreePath !== null && existsSync(repo.worktreePath))).toBe(true)
          expect(run.stacks).toEqual(['dotnet', 'angular'])
          expect(spec).toContain('health-api')
          expect(spec).toContain('health-web')
        },
      ),
    20 * 60_000,
  )
})

describe.runIf(!enabled)('a real Flow run (skipped)', () => {
  it('is opt-in: set REAL_SESSION=1 to run against a live session', () => {
    expect(enabled).toBe(false)
  })
})
