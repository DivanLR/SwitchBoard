import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cpus } from 'node:os'
import {
  cpuShare,
  gitNotice,
  homeVolumeFor,
  recipeTag,
  refMounts,
  sandboxImageFor,
  normalizeSize,
  sandboxMemoryArg,
  toContainerPaths,
} from '@main/sessions/wslc-sandbox'
import { sandboxSystemPromptAppend } from '@main/sessions/session-shaping'
import { explainExit } from '@main/sessions/session'
import {
  needsBrowser,
  sandboxTools,
  suiteById,
  unavailableReason,
} from '@shared/test-catalog'

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

  it('carries the git notice as its own line, and omits the line without one', () => {
    const note = 'The project is not a git repository — there is no git history to diff.'
    expect(sandboxSystemPromptAppend(MOUNTS, note)).toContain(`- Git: ${note}`)
    expect(sandboxSystemPromptAppend(MOUNTS)).not.toContain('- Git:')
  })
})

describe('gitNotice', () => {
  const dirs: string[] = []
  const scratch = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'gitnotice-'))
    dirs.push(dir)
    return dir
  }
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('is null when a real .git directory sits at the project root', () => {
    const root = scratch()
    mkdirSync(join(root, 'proj', '.git'), { recursive: true })
    expect(gitNotice(join(root, 'proj'))).toBeNull()
  })

  it('points at a repository nested one level down (the wrapper-folder shape)', () => {
    const root = scratch()
    mkdirSync(join(root, 'proj', 'Ppl.Einstein.External.Api', '.git'), { recursive: true })
    mkdirSync(join(root, 'proj', 'docs'))
    const note = gitNotice(join(root, 'proj'))
    expect(note).toContain('./Ppl.Einstein.External.Api')
    expect(note).toContain('run git commands from there')
  })

  it('says the repository root is outside the mount for a project inside a larger repo', () => {
    const root = scratch()
    mkdirSync(join(root, 'repo', '.git'), { recursive: true })
    mkdirSync(join(root, 'repo', 'src', 'api'), { recursive: true })
    const note = gitNotice(join(root, 'repo', 'src', 'api'))
    expect(note).toContain(join(root, 'repo'))
    expect(note).toContain('outside the container mount')
  })

  it('flags a .git file (worktree/submodule), whose real git dir is outside the mount', () => {
    const root = scratch()
    mkdirSync(join(root, 'proj'))
    writeFileSync(join(root, 'proj', '.git'), 'gitdir: ../somewhere/.git/worktrees/proj\n')
    expect(gitNotice(join(root, 'proj'))).toContain('worktree')
  })

  it('says plainly there is no history when there is no repository anywhere', () => {
    const root = scratch()
    mkdirSync(join(root, 'proj', 'src'), { recursive: true })
    expect(gitNotice(join(root, 'proj'))).toContain('not a git repository')
  })

  it('stays quiet on an unreadable folder rather than warning wrongly', () => {
    expect(gitNotice(join(scratch(), 'does-not-exist'))).toBeNull()
  })
})

describe('sandboxMemoryArg', () => {
  const saved = process.env.SWITCHBOARD_SANDBOX_MEMORY
  afterEach(() => {
    if (saved === undefined) delete process.env.SWITCHBOARD_SANDBOX_MEMORY
    else process.env.SWITCHBOARD_SANDBOX_MEMORY = saved
  })

  it('defaults to 6g with no setting and no env var', () => {
    delete process.env.SWITCHBOARD_SANDBOX_MEMORY
    expect(sandboxMemoryArg(undefined)).toEqual(['--memory', '6G'])
    expect(sandboxMemoryArg('   ')).toEqual(['--memory', '6G'])
  })

  it('uses the Settings value', () => {
    delete process.env.SWITCHBOARD_SANDBOX_MEMORY
    expect(sandboxMemoryArg('12g')).toEqual(['--memory', '12G'])
  })

  it("removes the cap entirely for '0'", () => {
    delete process.env.SWITCHBOARD_SANDBOX_MEMORY
    expect(sandboxMemoryArg('0')).toEqual([])
  })

  it('lets the env var override the setting', () => {
    process.env.SWITCHBOARD_SANDBOX_MEMORY = '9g'
    expect(sandboxMemoryArg('12g')).toEqual(['--memory', '9G'])
  })

  it('emits the cap alone, because wslc has no --memory-swap to pin it with', () => {
    delete process.env.SWITCHBOARD_SANDBOX_MEMORY
    for (const setting of [undefined, '4g', '12g', '512m']) {
      const args = sandboxMemoryArg(setting)
      expect(args).not.toContain('--memory-swap')
      expect(args[args.indexOf('--memory') + 1]).toBe(args[1])
      expect(args).toHaveLength(2)
    }
  })

  it('emits the cap in the case wslc accepts, whatever case it was stored in', () => {
    delete process.env.SWITCHBOARD_SANDBOX_MEMORY
    expect(sandboxMemoryArg('512m')).toEqual(['--memory', '512M'])
    expect(sandboxMemoryArg('1gb')).toEqual(['--memory', '1G'])
    expect(sandboxMemoryArg('2GiB')).toEqual(['--memory', '2G'])
    expect(sandboxMemoryArg('1.5g')).toEqual(['--memory', '1.5G'])
    expect(sandboxMemoryArg('12G')).toEqual(['--memory', '12G'])
  })

  it('passes an unrecognisable size through rather than inventing one', () => {
    delete process.env.SWITCHBOARD_SANDBOX_MEMORY
    expect(normalizeSize('lots')).toBe('lots')
    expect(normalizeSize('6 gigs')).toBe('6 gigs')
    expect(normalizeSize('1073741824')).toBe('1073741824')
  })
})

describe('cpuShare', () => {
  it('gives a container half the host, never fewer than two cores', () => {
    const share = Number(cpuShare())
    expect(Number.isInteger(share)).toBe(true)
    expect(share).toBeGreaterThanOrEqual(2)
    expect(share).toBeLessThanOrEqual(Math.max(2, cpus().length))
  })
})

describe('homeVolumeFor', () => {
  it('gives two fresh sessions of the same project different home volumes', () => {
    expect(homeVolumeFor('sess-a')).not.toBe(homeVolumeFor('sess-b'))
  })

  it('is stable for the same session id', () => {
    expect(homeVolumeFor('sess-a')).toBe(homeVolumeFor('sess-a'))
  })

  it('bridges a resuming session to its ANCESTOR volume, not a fresh one of its own', () => {
    expect(homeVolumeFor('sess-new', 'sess-old')).toBe(homeVolumeFor('sess-old'))
    expect(homeVolumeFor('sess-new', 'sess-old')).not.toBe(homeVolumeFor('sess-new'))
  })

  it('sanitises ids the same way container names are sanitised', () => {
    expect(homeVolumeFor('a/b c')).toBe('switchboard-claude-home-abc')
  })
})

describe('browser in the bypass container, only where earned', () => {
  it('is absent for a plain node project, and the suites that need it say why', () => {
    expect(needsBrowser(['package.json', 'src', 'vite.config.ts'])).toBe(false)

    const tools = sandboxTools(false, false)
    expect(tools).not.toContain('browser')

    const e2e = suiteById('node-e2e')!
    expect(e2e.needs).toBe('browser')
    expect(unavailableReason(e2e, tools)).toBe('browser is not in the bypass container')
  })

  it('is absent for a .NET API project, which has no screens to drive', () => {
    const tools = sandboxTools(true, false)
    expect(tools).toEqual(['node', 'dotnet'])
    expect(unavailableReason(suiteById('dotnet-unit')!, tools)).toBeNull()
  })

  it('is present for a project with a Playwright config', () => {
    expect(needsBrowser(['package.json', 'playwright.config.ts'])).toBe(true)
    expect(needsBrowser(['playwright.real.config.ts'])).toBe(true)
  })

  it('is present for an Angular workspace, whose unit tests run ChromeHeadless', () => {
    expect(needsBrowser(['angular.json', 'package.json'])).toBe(true)
    expect(needsBrowser(['karma.conf.js'])).toBe(true)
    for (const id of ['ng-unit', 'ng-coverage', 'ng-e2e', 'ng-mutation']) {
      expect(suiteById(id)!.needs).toBe('browser')
      expect(unavailableReason(suiteById(id)!, sandboxTools(false, true))).toBeNull()
    }
  })

  it('reads the manifest when there is no config file of its own', () => {
    const manifest = JSON.stringify({ devDependencies: { '@playwright/test': '^1.61.0' } })
    expect(needsBrowser(['package.json'], () => manifest)).toBe(true)
    expect(needsBrowser(['package.json'], () => '{"devDependencies":{"vitest":"^4"}}')).toBe(false)
  })

  it('says no when it cannot read anything, rather than assuming a browser', () => {
    expect(needsBrowser(['package.json'], () => null)).toBe(false)
    expect(needsBrowser([])).toBe(false)
  })

  it('gives a Blazor project its browser suites, which is why this matters now', () => {
    const tools = sandboxTools(true, true)
    expect(tools).toEqual(['node', 'dotnet', 'browser'])
    for (const id of ['blazor-ui', 'blazor-interactive']) {
      expect(suiteById(id)!.needs).toBe('browser')
      expect(unavailableReason(suiteById(id)!, tools)).toBeNull()
      expect(unavailableReason(suiteById(id)!, sandboxTools(true, false))).toContain('not in the bypass container')
    }
  })
})

describe('a container is not a permission decision', () => {
  it('tells a containerised session its node_modules is private, so a failed import is fixable', () => {
    const append = sandboxSystemPromptAppend([{ container: '/workspace' }], null, true)
    expect(append).toContain('/workspace/node_modules')
    expect(append).toMatch(/npm ci|npm install/)
    expect(append?.toLowerCase()).toContain('safe')
  })

  it('says nothing about node_modules for a project that has no package.json', () => {
    const append = sandboxSystemPromptAppend([{ container: '/workspace' }], null, false)
    expect(append).not.toContain('node_modules')
  })

  it('reports the container memory ceiling for any containerised session, not only a bypass one', () => {
    const detail = explainExit('exited with code 137', true)
    expect(detail).toContain('Sandbox memory')
    expect(detail).not.toContain('bypass sandbox')
  })
})

describe('the sandbox image tag', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sbimg-'))

  it('is content-addressed, so the tag is stable while the recipe is', () => {
    const first = sandboxImageFor(dir)
    expect(sandboxImageFor(dir)).toBe(first)
    expect(first).toMatch(/^switchboard-sandbox(-dotnet)?(-browser)?:[0-9a-f]{12}$/)
  })

  it('gives every distinct recipe its own tag', () => {
    const tags = new Set([
      recipeTag(false, false),
      recipeTag(false, true),
      recipeTag(true, false),
      recipeTag(true, true),
    ])
    expect(tags.size).toBe(4)
  })
})
