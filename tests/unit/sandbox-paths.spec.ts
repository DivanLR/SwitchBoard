// A bypass session's CLI runs in a Linux container, so a Windows path in the
// message text points at nothing. The composer appends `@<host path>` per REFS
// chip, so without translation the agent hunts for /mnt/c, finds nothing, and
// reports a repo unreachable that is in fact mounted read-only at /refs/<name>.
import { describe, expect, it } from 'vitest'
import { refMounts, toContainerPaths } from '@main/sessions/docker-sandbox'
import { sandboxSystemPromptAppend } from '@main/sessions/session-shaping'

const MOUNTS = [
  { host: 'C:\\GithubDesktop\\Pepkor\\MessageOrchestrator', container: '/workspace' },
  ...refMounts([
    'C:\\GithubDesktop\\Pepkor\\Einstein.Renewal.FE',
    'C:\\GithubDesktop\\Pepkor\\ExternalAPI',
  ]),
]

describe('refMounts', () => {
  it('mounts each ref under /refs/<basename>', () => {
    expect(refMounts(['C:\\a\\Einstein.Renewal.FE', 'C:\\b\\ExternalAPI'])).toEqual([
      { host: 'C:\\a\\Einstein.Renewal.FE', container: '/refs/Einstein.Renewal.FE' },
      { host: 'C:\\b\\ExternalAPI', container: '/refs/ExternalAPI' },
    ])
  })

  it('disambiguates two refs with the same folder name', () => {
    const [a, b] = refMounts(['C:\\one\\api', 'C:\\two\\api'])
    expect(a.container).toBe('/refs/api')
    expect(b.container).toBe('/refs/api-1')
  })
})

describe('toContainerPaths', () => {
  it('rewrites the @path the composer appends for a REFS chip', () => {
    const text = 'Fix the guard\n\n@C:\\GithubDesktop\\Pepkor\\Einstein.Renewal.FE\n@C:\\GithubDesktop\\Pepkor\\ExternalAPI'
    expect(toContainerPaths(text, MOUNTS)).toBe(
      'Fix the guard\n\n@/refs/Einstein.Renewal.FE\n@/refs/ExternalAPI',
    )
  })

  it('carries trailing segments across and normalises their separators', () => {
    expect(
      toContainerPaths('open C:\\GithubDesktop\\Pepkor\\ExternalAPI\\src\\Api\\Cancel.cs now', MOUNTS),
    ).toBe('open /refs/ExternalAPI/src/Api/Cancel.cs now')
  })

  it('maps the project itself to /workspace', () => {
    expect(toContainerPaths('C:\\GithubDesktop\\Pepkor\\MessageOrchestrator\\src\\x.ts', MOUNTS)).toBe(
      '/workspace/src/x.ts',
    )
  })

  it('prefers the longest match, so a ref nested in the project is not /workspace', () => {
    const nested = [
      { host: 'C:\\repo', container: '/workspace' },
      { host: 'C:\\repo\\vendor\\lib', container: '/refs/lib' },
    ]
    expect(toContainerPaths('C:\\repo\\vendor\\lib\\index.ts', nested)).toBe('/refs/lib/index.ts')
    expect(toContainerPaths('C:\\repo\\src\\index.ts', nested)).toBe('/workspace/src/index.ts')
  })

  it('accepts either separator and any drive-letter casing', () => {
    expect(toContainerPaths('c:/GithubDesktop/Pepkor/ExternalAPI/README.md', MOUNTS)).toBe(
      '/refs/ExternalAPI/README.md',
    )
  })

  it('leaves text with no host path alone', () => {
    const text = 'Run npm test and report the first failure'
    expect(toContainerPaths(text, MOUNTS)).toBe(text)
  })
})

describe('sandboxSystemPromptAppend', () => {
  it('names every mount and forbids the clone-a-mounted-repo dead end', () => {
    const note = sandboxSystemPromptAppend(MOUNTS) as string
    expect(note).toContain('/workspace')
    expect(note).toContain('/refs/Einstein.Renewal.FE')
    expect(note).toContain('/refs/ExternalAPI')
    expect(note).toContain('/mnt/c/...')
    expect(note).toContain('Never ask for a git clone')
  })

  it('spells out the search command, since refs sit outside the cwd', () => {
    const note = sandboxSystemPromptAppend(MOUNTS) as string
    // "0 hits repo-wide" from /workspace says nothing about a ref — the agent has
    // to be told to pass them, and given the exact command.
    expect(note).toContain('does not reach them')
    expect(note).toContain('rg -n "pattern" /workspace /refs/Einstein.Renewal.FE /refs/ExternalAPI')
  })

  it('says refs mount only from the next session when none are mounted', () => {
    const note = sandboxSystemPromptAppend([{ container: '/workspace' }]) as string
    expect(note).toContain('No referenced folders are mounted')
    expect(note).toContain('ask for a restart')
  })

  it('is absent for a non-sandboxed session', () => {
    expect(sandboxSystemPromptAppend([])).toBeNull()
  })
})
