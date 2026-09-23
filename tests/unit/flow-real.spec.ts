import { describe, expect, it, vi } from 'vitest'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FlowStageStatus } from '@shared/domain'
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

describe.runIf(enabled)('a real Flow run (spec stage smoke)', () => {
  it(
    'specifies a small feature in its own worktree and holds it at review',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'switchboard-flow-'))
      const repo = join(root, 'health-api')
      mkdirSync(repo)
      writeFileSync(join(repo, 'HealthApi.csproj'), CSPROJ)
      execSync('git init', { cwd: repo })
      execSync('git add HealthApi.csproj', { cwd: repo })
      execSync(
        'git -c user.name=Switchboard -c user.email=flow-smoke@example.invalid commit -m "Initial commit"',
        {
          cwd: repo,
        },
      )

      const db = openDatabase(':memory:')
      const repos = createRepositories(db)
      const project = repos.projects.insert({ name: 'flow-smoke', path: repo, source: 'manual' })

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
        const run = await flow.start({
          projectId: project.id,
          source: {
            kind: 'text',
            title: 'Health endpoint',
            description: 'Add a GET /health endpoint that returns ok',
          },
          autopilot: true,
          autoShip: false,
        })
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
        if (existsSync(specPath)) console.log(readFileSync(specPath, 'utf8').slice(0, 1200))
        expect(existsSync(specPath)).toBe(true)
        expect(repos.flowRuns.byId(runId)?.stage).toBe('spec')
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
    },
    20 * 60_000,
  )
})

describe.runIf(!enabled)('a real Flow run (skipped)', () => {
  it('is opt-in: set REAL_SESSION=1 to run against a live session', () => {
    expect(enabled).toBe(false)
  })
})
