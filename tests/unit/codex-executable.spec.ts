// How Codex is launched, which is not the same question as where it lives.
//
// The case that matters is a standard Windows `npm i -g @openai/codex`: the only
// thing on the PATH is `codex.cmd`, and Node's spawn REFUSES a `.cmd` without
// `shell: true` (EINVAL, the CVE-2024-27980 hardening). The resolver therefore
// has to produce something else, and `shell: true` is not an option — the prompt
// is an argument, and a prompt handed to a shell is a command substitution
// waiting to run.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { resolveCodexLaunch, codexInstalled } from '@main/sessions/codex-executable'

const made: string[] = []

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codex-exe-'))
  made.push(dir)
  return dir
}

/** A PATH holding exactly `dir`, so nothing on the real machine can answer instead. */
function onlyPath(dir: string): void {
  vi.stubEnv('PATH', dir)
  vi.stubEnv('APPDATA', join(dir, 'no-such-appdata'))
  vi.stubEnv('HOME', join(dir, 'no-such-home'))
}

afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('resolveCodexLaunch', () => {
  it('reports nothing when Codex is not installed', () => {
    onlyPath(sandbox())
    expect(resolveCodexLaunch()).toBeNull()
    expect(codexInstalled()).toBe(false)
  })

  // THE WINDOWS CASE. A `.cmd` shim alone must still produce a launch, and that
  // launch must not be the shim: spawning it is what fails.
  it('launches through the package entry point when only the npm shim is present', () => {
    const dir = sandbox()
    writeFileSync(join(dir, 'codex.cmd'), '@echo off\r\n')
    const binDir = join(dir, 'node_modules', '@openai', 'codex', 'bin')
    mkdirSync(binDir, { recursive: true })
    const entry = join(binDir, 'codex.js')
    writeFileSync(entry, '#!/usr/bin/env node\n')
    onlyPath(dir)

    const launch = resolveCodexLaunch()
    expect(launch).not.toBeNull()
    expect(launch?.command).toBe(process.execPath)
    expect(launch?.prefixArgs).toEqual([entry])
    // Under Electron, process.execPath is the Electron binary; without this it
    // would start a second Electron rather than run the script.
    expect(launch?.env.ELECTRON_RUN_AS_NODE).toBe('1')
    // Never the shim itself, whatever else changes here.
    expect(launch?.command.endsWith('.cmd')).toBe(false)
    expect(launch?.prefixArgs.some((a) => a.endsWith('.cmd'))).toBe(false)
  })

  it('prefers a real executable, which needs no interpreter', () => {
    const dir = sandbox()
    const name = process.platform === 'win32' ? 'codex.exe' : 'codex'
    const executable = join(dir, name)
    writeFileSync(executable, '')
    const binDir = join(dir, 'node_modules', '@openai', 'codex', 'bin')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'codex.js'), '')
    onlyPath(dir)

    const launch = resolveCodexLaunch()
    expect(launch?.command).toBe(executable)
    expect(launch?.prefixArgs).toEqual([])
    expect(launch?.env).toEqual({})
  })

  it('searches the npm global bin, which a packaged app does not always inherit', () => {
    const dir = sandbox()
    // APPDATA/npm is where a global install lands on Windows.
    const binDir = join(dir, 'npm', 'node_modules', '@openai', 'codex', 'bin')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'codex.js'), '')
    // Not on PATH at all — only reachable through APPDATA.
    vi.stubEnv('PATH', join(dir, 'elsewhere') + delimiter + join(dir, 'also-nowhere'))
    vi.stubEnv('APPDATA', dir)
    vi.stubEnv('HOME', join(dir, 'no-such-home'))

    expect(resolveCodexLaunch()?.prefixArgs).toEqual([join(binDir, 'codex.js')])
  })
})
