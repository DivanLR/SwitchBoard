import { describe, expect, it } from 'vitest'
import { explainExit } from '@main/sessions/session'

describe('explainExit', () => {
  it('names a killed process and blames a host memory shortage', () => {
    const msg = explainExit('Claude Code process exited with code 137')
    expect(msg).toContain('SIGKILL')
    expect(msg).toContain('ran out of memory')
  })

  it('reads 13 as the unfinished top-level await it actually is', () => {
    const msg = explainExit('Claude Code process exited with code 13')
    expect(msg).toContain('top-level await')
    expect(msg).not.toContain('SIGKILL')
  })

  it('passes anything it cannot explain through verbatim, rather than guessing', () => {
    const raw = 'Claude Code process exited with code 2'
    expect(explainExit(raw)).toBe(`Session process ended unexpectedly: ${raw}`)
    expect(explainExit('spawn ENOENT')).toBe('Session process ended unexpectedly: spawn ENOENT')
  })
})
