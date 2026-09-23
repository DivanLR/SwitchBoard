import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CustomSkill, KeepCurrentReport } from '@shared/domain'
import { keepCurrentService, refreshSkills, updatePlugins, updateSpecKit, type CommandRunner } from '@main/keep-current'
import { openDatabase } from '@main/store/db'
import { createRepositories } from '@main/store/repositories'

interface Call {
  exe: string
  args: readonly string[]
  cwd?: string
}

function fakeRunner(answer: (args: readonly string[]) => { code?: number; stdout?: string; stderr?: string }) {
  const calls: Call[] = []
  const run: CommandRunner = async (exe, args, cwd) => {
    calls.push({ exe, args, cwd })
    const { code = 0, stdout = '', stderr = '' } = answer(args)
    return { code, stdout, stderr }
  }
  return { run, calls }
}

let home: string
const previous = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME }

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'sb-keep-'))
  process.env.USERPROFILE = home
  process.env.HOME = home
})

afterEach(async () => {
  vi.unstubAllGlobals()
  process.env.USERPROFILE = previous.USERPROFILE
  process.env.HOME = previous.HOME
  await rm(home, { recursive: true, force: true })
})

describe('updatePlugins', () => {
  it('refreshes every marketplace, then updates every installed plugin in its own scope without ever confirming for the person', async () => {
    const project = join(home, 'project')
    await mkdir(project)
    const updateLine = (body: Record<string, unknown>) => JSON.stringify({ command: 'update', ...body })
    const { run, calls } = fakeRunner((args) => {
      const joined = args.join(' ')
      const plugin = args[1] === 'update' ? args[2] : null
      if (joined === 'plugin marketplace update ponytail') return { stdout: 'Successfully updated marketplace: ponytail' }
      if (joined === 'plugin marketplace list --json') {
        return { stdout: JSON.stringify([{ name: 'ponytail' }, { name: 'broken-market' }]) }
      }
      if (joined === 'plugin marketplace update broken-market') return { code: 1, stderr: 'Could not reach GitHub' }
      if (joined === 'plugin list --json') {
        return {
          stdout: JSON.stringify([
            { id: 'ponytail@ponytail', scope: 'user' },
            { id: 'impeccable@impeccable', scope: 'user' },
            { id: 'brag@brag', scope: 'project', projectPath: project },
            { id: 'kit@kit', scope: 'local', projectPath: join(home, 'gone') },
            { id: 'odd@odd', scope: 'user' },
            { id: 'corp@corp', scope: 'managed' },
          ]),
        }
      }
      if (plugin === 'ponytail@ponytail') {
        return {
          stdout: `Checking…\n${updateLine({ outcome: 'ok', updateOutcome: 'updated', message: 'Plugin "ponytail" updated from 4.8.4 to 4.9.0.' })}`,
        }
      }
      if (plugin === 'impeccable@impeccable') {
        return { stdout: updateLine({ outcome: 'ok', updateOutcome: 'up_to_date', message: 'impeccable is already at the latest version (4.0.4).' }) }
      }
      if (plugin === 'brag@brag') {
        return {
          code: 1,
          stdout: updateLine({
            outcome: 'failed',
            failureCode: 'entry_helper_unconfirmed',
            message: 'The marketplace declares a command to fetch it.',
            shownCommand: { sha256: 'abc' },
          }),
        }
      }
      return { code: 1, stdout: updateLine({ outcome: 'failed', failureCode: 'op_failed', message: 'odd is not in any marketplace.' }) }
    })

    const results = await updatePlugins(run, 'claude.exe')

    expect(results).toEqual([
      { kind: 'marketplace', name: 'ponytail', status: 'current', detail: 'Catalogue refreshed.' },
      { kind: 'marketplace', name: 'broken-market', status: 'failed', detail: 'Could not reach GitHub' },
      { kind: 'plugin', name: 'ponytail@ponytail', status: 'updated', detail: 'Plugin "ponytail" updated from 4.8.4 to 4.9.0.' },
      { kind: 'plugin', name: 'impeccable@impeccable', status: 'current', detail: 'impeccable is already at the latest version (4.0.4).' },
      {
        kind: 'plugin',
        name: 'brag@brag (project)',
        status: 'needs_confirmation',
        detail: expect.stringContaining('The marketplace declares a command to fetch it.'),
      },
      { kind: 'plugin', name: 'kit@kit (local)', status: 'failed', detail: expect.stringContaining('is gone') },
      { kind: 'plugin', name: 'odd@odd', status: 'failed', detail: 'odd is not in any marketplace.' },
    ])
    for (const call of calls) {
      expect(call.exe).toBe('claude.exe')
      expect(call.args).not.toContain('-y')
      expect(call.args).not.toContain('--yes')
      expect(call.args.some((arg) => arg.startsWith('--accept-command'))).toBe(false)
    }
    expect(calls.find((call) => call.args[1] === 'update' && call.args[2] === 'brag@brag')).toEqual({
      exe: 'claude.exe',
      args: ['plugin', 'update', 'brag@brag', '--scope', 'project', '--json'],
      cwd: project,
    })
    expect(calls.some((call) => call.args.includes('corp@corp') || call.args.includes('kit@kit'))).toBe(false)
  })

  it('reads installed_plugins.json when the CLI cannot list plugins as JSON, and refreshes every marketplace at once', async () => {
    await mkdir(join(home, '.claude', 'plugins'), { recursive: true })
    await writeFile(
      join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { 'ponytail@ponytail': [{ scope: 'user', version: '4.8.4' }] } }),
    )
    const { run, calls } = fakeRunner((args) =>
      args.includes('--json') && args[1] !== 'update' ? { code: 1, stderr: "error: unknown option '--json'" } : {},
    )

    const results = await updatePlugins(run, 'claude.exe')

    expect(results.map((r) => [r.name, r.status])).toEqual([
      ['every marketplace', 'current'],
      ['ponytail@ponytail', 'current'],
    ])
    expect(calls.map((call) => call.args.join(' '))).toContain('plugin marketplace update')
    expect(calls.map((call) => call.args.join(' '))).toContain('plugin update ponytail@ponytail --scope user --json')
  })
})

describe('updateSpecKit', () => {
  const offered = '🔄 Checking for updates...\n\nUpdates available:\n\n  • bug: 0.0.1 → 1.0.0\n\nUpdate these extensions? [y/N]: '

  it('runs the pinned specify extension update only where extensions are installed, and answers its one prompt', async () => {
    const withExtensions = join(home, 'with')
    const without = join(home, 'without')
    await mkdir(join(withExtensions, '.specify', 'extensions', 'bug'), { recursive: true })
    await mkdir(join(without, '.specify'), { recursive: true })
    const calls: (Call & { input?: string })[] = []
    const run: CommandRunner = async (exe, args, cwd, input) => {
      calls.push({ exe, args, cwd, input })
      return input === 'y\n'
        ? { code: 0, stdout: `${offered}\n📦 Updating bug...\n\n✓ Successfully updated 1 extension(s)\n`, stderr: '' }
        : { code: 1, stdout: `${offered}\nAborted.\n`, stderr: '' }
    }

    const results = await updateSpecKit(run, 'uvx.exe', [
      { name: 'with', path: withExtensions },
      { name: 'without', path: without },
    ])

    expect(results).toMatchObject([{ kind: 'speckit', name: 'with', status: 'updated', detail: expect.stringContaining('Successfully updated') }])
    expect(calls).toEqual([
      {
        exe: 'uvx.exe',
        args: ['--from', 'git+https://github.com/github/spec-kit.git', 'specify', 'extension', 'update'],
        cwd: withExtensions,
        input: 'y\n',
      },
    ])
  })

  it('reports current, not updated, when the CLI exits cleanly without updating anything', async () => {
    const withExtensions = join(home, 'with')
    await mkdir(join(withExtensions, '.specify', 'extensions'), { recursive: true })
    await writeFile(join(withExtensions, '.specify', 'extensions', '.registry'), '{}')
    for (const stdout of ['🔄 Checking for updates...\n\nAll extensions are up to date!', 'No extensions installed', `${offered}\nCancelled`]) {
      const { run } = fakeRunner(() => ({ stdout }))
      expect((await updateSpecKit(run, 'uvx.exe', [{ name: 'with', path: withExtensions }]))[0].status, stdout).toBe('current')
    }
    const failing = fakeRunner(() => ({ code: 1, stderr: 'No catalog reachable' }))
    expect(await updateSpecKit(failing.run, 'uvx.exe', [{ name: 'with', path: withExtensions }])).toEqual([
      { kind: 'speckit', name: 'with', status: 'failed', detail: 'No catalog reachable' },
    ])
  })
})

describe('refreshSkills', () => {
  const SOURCE = 'https://github.com/someone/skills/tree/main'
  const manifest = (body: string) => `---\nname: research\ndescription: Researches.\n---\n${body}\n`
  const gitSha = (text: string) =>
    createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex')
  const skill: CustomSkill = {
    name: 'research',
    description: 'Researches.',
    sourceUrl: SOURCE,
    sourcePath: 'skills/research',
    enabled: true,
    fileCount: 1,
    importedAt: '2026-09-01T00:00:00.000Z',
  }

  let staging: string
  let live: string

  beforeEach(async () => {
    staging = join(home, 'staging')
    live = join(home, '.claude', 'skills')
    for (const root of [staging, live]) {
      await mkdir(join(root, 'research'), { recursive: true })
      await writeFile(join(root, 'research', 'SKILL.md'), manifest('v1'))
    }
  })

  function stubSource(upstream: string): string[] {
    const downloads: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.startsWith('https://api.github.com/')) {
        return new Response(
          JSON.stringify({
            tree: [{ path: 'skills/research/SKILL.md', type: 'blob', size: 64, sha: gitSha(upstream) }],
          }),
        )
      }
      downloads.push(url)
      return new Response(upstream)
    })
    return downloads
  }

  it('leaves a skill whose source has not changed alone, without downloading it', async () => {
    const downloads = stubSource(manifest('v1'))
    const saved: CustomSkill[] = []

    expect(await refreshSkills([skill], staging, (s) => saved.push(s))).toEqual([
      { kind: 'skill', name: 'research', status: 'current', detail: 'No change at its source.' },
    ])
    expect(downloads).toEqual([])
    expect(saved).toEqual([])
  })

  it('re-imports a changed skill through the import path and puts it live', async () => {
    stubSource(manifest('v2'))
    const saved: CustomSkill[] = []

    const results = await refreshSkills([skill], staging, (s) => saved.push(s))

    expect(results).toMatchObject([{ name: 'research', status: 'updated' }])
    expect(saved).toMatchObject([{ name: 'research', sourceUrl: SOURCE, sourcePath: 'skills/research', enabled: true }])
    expect(await readFile(join(staging, 'research', 'SKILL.md'), 'utf8')).toBe(manifest('v2'))
    expect(await readFile(join(live, 'research', 'SKILL.md'), 'utf8')).toBe(manifest('v2'))
  })

  it('updates a skill whose live copy only gained files Python or Windows generate there', async () => {
    stubSource(manifest('v2'))
    await mkdir(join(live, 'research', 'scripts', '__pycache__'), { recursive: true })
    await writeFile(join(live, 'research', 'scripts', '__pycache__', 'helper.cpython-311.pyc'), 'bytecode')
    await writeFile(join(live, 'research', 'desktop.ini'), '[.ShellClassInfo]')

    const results = await refreshSkills([skill], staging, () => {})

    expect(results).toMatchObject([{ name: 'research', status: 'updated' }])
    expect(await readFile(join(live, 'research', 'SKILL.md'), 'utf8')).toBe(manifest('v2'))
  })

  it('leaves alone a skill the person switched off or removed while its update downloaded', async () => {
    stubSource(manifest('v2'))
    const saved: CustomSkill[] = []

    for (const now of [{ ...skill, enabled: false }, undefined]) {
      await writeFile(join(staging, 'research', 'SKILL.md'), manifest('v1'))
      const results = await refreshSkills([skill], staging, (s) => saved.push(s), () => now)
      expect(results).toEqual([])
    }
    expect(saved).toEqual([])
    expect(await readFile(join(live, 'research', 'SKILL.md'), 'utf8')).toBe(manifest('v1'))
  })

  it('never overwrites a live copy the person edited, and skips a disabled skill', async () => {
    stubSource(manifest('v2'))
    await writeFile(join(live, 'research', 'SKILL.md'), manifest('my own edit'))

    const results = await refreshSkills(
      [skill, { ...skill, name: 'off', enabled: false }],
      staging,
      () => {},
    )

    expect(results).toMatchObject([{ name: 'research', status: 'failed', detail: expect.stringContaining('changes of your own') }])
    expect(await readFile(join(live, 'research', 'SKILL.md'), 'utf8')).toBe(manifest('my own edit'))
    expect(await readFile(join(staging, 'research', 'SKILL.md'), 'utf8')).toBe(manifest('v1'))
  })
})

describe('keepCurrentService', () => {
  it('hands every finished check to onReport, so an open Settings page can show it', async () => {
    const repos = createRepositories(openDatabase(':memory:'))
    const reports: KeepCurrentReport[] = []
    const { run } = fakeRunner(() => ({ code: 1, stderr: 'offline' }))
    const service = keepCurrentService({ repos, stagingRoot: join(home, 'staging'), run, onReport: (r) => reports.push(r) })

    const report = await service.check()

    expect(reports).toEqual([report])
    expect(repos.settings.get().keepCurrentLast).toEqual(report)
  })
})
