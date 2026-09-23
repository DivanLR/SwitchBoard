import { describe, expect, it } from 'vitest'
import { explainExit } from '@main/sessions/session'

describe('explainExit', () => {
  it('names a killed bypass container and both ceilings it could have hit', () => {
    const msg = explainExit('Claude Code process exited with code 137', true)
    expect(msg).toContain('SIGKILL')
    expect(msg).toContain('ran out of memory')
    expect(msg).toContain('SWITCHBOARD_SANDBOX_MEMORY')
    expect(msg).toContain('.wslconfig')
    expect(msg).toContain('Settings')
    expect(msg).toContain('resumes')
    expect(msg).not.toContain('ended unexpectedly')
  })

  it('does not blame a container when the session never used one', () => {
    const msg = explainExit('Claude Code process exited with code 137', false)
    expect(msg).toContain('SIGKILL')
    expect(msg).not.toContain('container')
    expect(msg).not.toContain('.wslconfig')
  })

  it('reads 13 as the unfinished top-level await it actually is', () => {
    const msg = explainExit('Claude Code process exited with code 13', true)
    expect(msg).toContain('top-level await')
    expect(msg).not.toContain('SIGKILL')
  })

  it('passes anything it cannot explain through verbatim, rather than guessing', () => {
    const raw = 'Claude Code process exited with code 2'
    expect(explainExit(raw, true)).toBe(`Session process ended unexpectedly: ${raw}`)
    expect(explainExit('spawn ENOENT', false)).toBe('Session process ended unexpectedly: spawn ENOENT')
  })
})
