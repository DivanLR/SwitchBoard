import { describe, expect, it, vi } from 'vitest'

const { outcome } = vi.hoisted(() => ({
  outcome: { error: null as unknown, stdout: '', stdin: [] as (string | undefined)[] },
}))

vi.mock('node:child_process', () => ({
  execFile: (_exe: string, _args: string[], _opts: unknown, done: (e: unknown, out: string, err: string) => void) => {
    queueMicrotask(() => done(outcome.error, outcome.stdout, ''))
    return { stdin: { end: (input?: string) => outcome.stdin.push(input) } }
  },
  execFileSync: () => '',
}))

const { run, reason } = await import('@main/sessions/plugin-install')

describe('run', () => {
  it('reports a command it stopped on its timeout as a failure that says so, never as exit code 0', async () => {
    outcome.error = Object.assign(new Error('Command failed'), { code: null, killed: true, signal: 'SIGTERM' })
    outcome.stdout = 'Updating marketplace…'

    const result = await run('claude.exe', ['plugin', 'marketplace', 'update', 'corp'])

    expect(result.code).toBeNull()
    expect(reason(result)).toContain('timed out')
  })

  it('writes the given input to the command and then closes its stdin', async () => {
    outcome.error = null
    outcome.stdin.length = 0

    expect((await run('uvx.exe', ['specify'], undefined, 'y\n')).code).toBe(0)
    expect(outcome.stdin).toEqual(['y\n'])
  })
})
