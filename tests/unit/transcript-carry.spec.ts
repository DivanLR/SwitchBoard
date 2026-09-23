import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { queryOptions } = vi.hoisted(() => ({ queryOptions: [] as { systemPrompt?: { append?: string } }[] }))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: () => ({ type: 'sdk', name: 'switchboard', instance: {} }),
  tool: () => ({}),
  query: (args: { options?: { systemPrompt?: { append?: string } } }) => {
    queryOptions.push(args.options ?? {})
    return {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
      supportedCommands: () => Promise.resolve([]),
      supportedModels: () => Promise.resolve([]),
      interrupt: () => Promise.resolve(),
      applyFlagSettings: () => Promise.resolve(),
      setModel: () => Promise.resolve(),
    }
  },
}))

vi.mock('@main/sessions/claude-executable', () => ({
  resolveClaudeExecutable: () => 'C:\\fake\\claude.exe',
}))

const { openDatabase } = await import('@main/store/db')
const { createRepositories } = await import('@main/store/repositories')
const { SessionManager } = await import('@main/sessions/session-manager')
const { transcriptFor } = await import('@main/sessions/transcript')

type Inner = {
  hosted: Map<string, unknown>
  handleExit(entry: unknown, reason: 'completed' | 'stopped' | 'crashed'): void
}

const cleanup: string[] = []
afterEach(() => {
  queryOptions.length = 0
  for (const path of cleanup.splice(0)) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {}
  }
})

function setup() {
  const repos = createRepositories(openDatabase(':memory:'))
  const dir = mkdtempSync(join(tmpdir(), 'transcript-carry-'))
  cleanup.push(dir)
  const project = repos.projects.insert({ name: 'alpha', path: dir, source: 'manual' })
  const manager = new SessionManager(repos, {
    onEvent: () => {},
    onSessionStatus: () => {},
    onCountersChanged: () => {},
    onSessionExit: () => {},
    onQueueChanged: () => {},
    onVerifyChanged: () => {},
    onDiagramsChanged: () => {},
    onProjectCommands: () => {},
    gate: (() => {}) as never,
  })
  return { project, manager, inner: manager as unknown as Inner }
}

describe('a session transcript', () => {
  it('is written when the session ends and seeds a new session started with it', async () => {
    const h = setup()
    const first = await h.manager.startSession(h.project.id, false, 'default', { containerised: false })
    h.manager.sendMessage(first.id, 'tighten the lane rows')
    h.inner.handleExit(h.inner.hosted.get(first.id), 'stopped')

    const saved = transcriptFor(first.id)
    expect(saved?.prompts).toBe(1)
    cleanup.push(saved!.path)
    expect(readFileSync(saved!.path, 'utf8')).toContain('tighten the lane rows')

    const second = await h.manager.startSession(h.project.id, false, 'default', {
      containerised: false,
      carryTranscriptFrom: first.id,
    })
    h.manager.sendMessage(second.id, 'carry on')
    const append = queryOptions.at(-1)?.systemPrompt?.append ?? ''
    expect(append).toContain('Carried context from the previous session')
    expect(append).toContain(saved!.digest)
    expect(append).toContain(saved!.path)
    h.inner.handleExit(h.inner.hosted.get(second.id), 'stopped')
    const secondPath = transcriptFor(second.id)?.path
    if (secondPath) cleanup.push(secondPath)
  })

  it('carries nothing into a session started without it', async () => {
    const h = setup()
    const session = await h.manager.startSession(h.project.id, false, 'default', { containerised: false })
    h.manager.sendMessage(session.id, 'hello')
    expect(queryOptions.at(-1)?.systemPrompt?.append ?? '').not.toContain('Carried context')
    h.inner.handleExit(h.inner.hosted.get(session.id), 'stopped')
    const path = transcriptFor(session.id)?.path
    expect(path && existsSync(path)).toBe(true)
    if (path) cleanup.push(path)
  })
})
