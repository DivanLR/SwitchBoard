// A killed process cannot explain itself, so the app has to. Every crash in this
// user's history was exit 137 on a bypass session, reported as "crashed" with the
// raw SDK string — an environment limit dressed up as the developer's code failing,
// which is the one thing PRODUCT.md forbids.
import { describe, expect, it } from 'vitest'
import { explainExit } from '@main/sessions/session'

describe('explainExit', () => {
  it('names a killed bypass container and says how to give it more memory', () => {
    const msg = explainExit('Claude Code process exited with code 137', true)
    expect(msg).toContain('SIGKILL')
    expect(msg).toContain('running out of memory')
    expect(msg).toContain('.wslconfig')
    // The developer must know their work is not lost.
    expect(msg).toContain('resumes')
    // And it must not read as their code crashing.
    expect(msg).not.toContain('ended unexpectedly')
  })

  it('does not blame a container when the session never used one', () => {
    const msg = explainExit('Claude Code process exited with code 137', false)
    expect(msg).toContain('SIGKILL')
    expect(msg).not.toContain('container')
    expect(msg).not.toContain('.wslconfig')
  })

  it('reads 13 as the unfinished top-level await it actually is', () => {
    // 13 and 137 are entirely different diagnoses and must never be conflated.
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
