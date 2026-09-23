import { existsSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { CustomSkill, KeepCurrentReport, KeepCurrentResult, KeepCurrentStatus } from '@shared/domain'
import { isIpcError } from '@shared/ipc-types'
import { resolveClaudeExecutable } from '@main/sessions/claude-executable'
import { reason, run as runCommand, type RunResult } from '@main/sessions/plugin-install'
import { pinnedSpecify } from '@main/specs/spec-kit'
import { folderShas, importSkills, remoteSkillShas } from '@main/skills/import'
import { enableSkill, liveSkillFolders, liveSkillsRoot } from '@main/skills/install'
import type { Repositories } from '@main/store/repositories'

export type CommandRunner = (exe: string, args: readonly string[], cwd?: string, input?: string) => Promise<RunResult>

const CONFIRM_CODES: ReadonlySet<string> = new Set([
  'command_source_refused',
  'command_source_declined',
  'entry_helper_unconfirmed',
  'entry_helper_declined',
])

const START_DELAY_MS = 30_000
const DAY_MS = 24 * 60 * 60 * 1000

interface InstalledPlugin {
  id: string
  scope: string
  projectPath?: string
}

function entry(
  kind: KeepCurrentResult['kind'],
  name: string,
  status: KeepCurrentStatus,
  detail: string,
): KeepCurrentResult {
  return { kind, name, status, detail }
}

function errorText(error: unknown): string {
  if (isIpcError(error)) return error.message
  return error instanceof Error ? error.message : String(error)
}

async function tryRun(
  run: CommandRunner,
  exe: string,
  args: readonly string[],
  cwd?: string,
  input?: string,
): Promise<RunResult> {
  try {
    return await run(exe, args, cwd, input)
  } catch (error) {
    return { code: null, stdout: '', stderr: errorText(error) }
  }
}

function lastJson(text: string): Record<string, unknown> | null {
  for (const line of text.split(/\r?\n/).reverse()) {
    if (!line.trim().startsWith('{')) continue
    try {
      return JSON.parse(line) as Record<string, unknown>
    } catch {}
  }
  return null
}

function jsonArray(text: string): Record<string, unknown>[] | null {
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : null
  } catch {
    return null
  }
}

async function installedPlugins(run: CommandRunner, claude: string): Promise<InstalledPlugin[]> {
  const listed = await tryRun(run, claude, ['plugin', 'list', '--json'])
  const rows = listed.code === 0 ? jsonArray(listed.stdout) : null
  if (rows) {
    return rows.flatMap((row) =>
      typeof row.id === 'string' && typeof row.scope === 'string'
        ? [{ id: row.id, scope: row.scope, projectPath: typeof row.projectPath === 'string' ? row.projectPath : undefined }]
        : [],
    )
  }
  const file = JSON.parse(
    await readFile(join(homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf8'),
  ) as { plugins?: Record<string, { scope: string; projectPath?: string }[]> }
  return Object.entries(file.plugins ?? {}).flatMap(([id, installs]) =>
    installs.map((install) => ({ id, scope: install.scope, projectPath: install.projectPath })),
  )
}

async function updatePlugin(run: CommandRunner, claude: string, plugin: InstalledPlugin): Promise<KeepCurrentResult> {
  const name = plugin.scope === 'user' ? plugin.id : `${plugin.id} (${plugin.scope})`
  if (plugin.projectPath && !existsSync(plugin.projectPath)) {
    return entry('plugin', name, 'failed', `Its project folder ${plugin.projectPath} is gone.`)
  }
  const result = await tryRun(
    run,
    claude,
    ['plugin', 'update', plugin.id, '--scope', plugin.scope, '--json'],
    plugin.projectPath,
  )
  const json = lastJson(result.stdout)
  const detail = typeof json?.message === 'string' ? json.message : reason(result)
  if (json?.outcome === 'ok') {
    if (json.updateOutcome === 'updated') return entry('plugin', name, 'updated', detail)
    if (json.updateOutcome === 'up_to_date') return entry('plugin', name, 'current', detail)
    return entry('plugin', name, 'failed', detail)
  }
  if (json?.shownCommand || CONFIRM_CODES.has(String(json?.failureCode))) {
    return entry(
      'plugin',
      name,
      'needs_confirmation',
      `${detail} Update it yourself with claude plugin update ${plugin.id} to review the command first.`,
    )
  }
  if (!json && result.code === 0) return entry('plugin', name, 'current', detail)
  return entry('plugin', name, 'failed', detail)
}

export async function updatePlugins(run: CommandRunner, claude: string): Promise<KeepCurrentResult[]> {
  const out: KeepCurrentResult[] = []
  const listed = await tryRun(run, claude, ['plugin', 'marketplace', 'list', '--json'])
  const marketplaces = (listed.code === 0 ? jsonArray(listed.stdout) : null)?.flatMap((row) =>
    typeof row.name === 'string' ? [row.name] : [],
  )
  for (const name of marketplaces ?? [null]) {
    const refreshed = await tryRun(run, claude, ['plugin', 'marketplace', 'update', ...(name ? [name] : [])])
    out.push(
      entry(
        'marketplace',
        name ?? 'every marketplace',
        refreshed.code === 0 ? 'current' : 'failed',
        refreshed.code === 0 ? 'Catalogue refreshed.' : reason(refreshed),
      ),
    )
  }
  let plugins: InstalledPlugin[]
  try {
    plugins = await installedPlugins(run, claude)
  } catch (error) {
    out.push(entry('plugin', 'installed plugins', 'failed', `Could not list them: ${errorText(error)}`))
    return out
  }
  for (const plugin of plugins) {
    if (plugin.scope !== 'managed') out.push(await updatePlugin(run, claude, plugin))
  }
  return out
}

function hasEntries(dir: string): boolean {
  try {
    return readdirSync(dir).length > 0
  } catch {
    return false
  }
}

export async function updateSpecKit(
  run: CommandRunner,
  uvx: string,
  projects: readonly { name: string; path: string }[],
): Promise<KeepCurrentResult[]> {
  const out: KeepCurrentResult[] = []
  for (const project of projects) {
    if (!hasEntries(join(project.path, '.specify', 'extensions'))) continue
    const result = await tryRun(run, uvx, pinnedSpecify('extension', 'update'), project.path, 'y\n')
    const status: KeepCurrentStatus =
      result.code !== 0 ? 'failed' : /Successfully updated/i.test(result.stdout) ? 'updated' : 'current'
    out.push(entry('speckit', project.name, status, reason(result)))
  }
  return out
}

function sameFiles(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  return a.size === b.size && [...a].every(([path, sha]) => b.get(path) === sha)
}

const GENERATED = /(^|\/)(__pycache__\/|\.DS_Store$|desktop\.ini$)|\.pyc$/i

function ownFiles(files: ReadonlyMap<string, string>): Map<string, string> {
  return new Map([...files].filter(([path]) => !GENERATED.test(path)))
}

export async function refreshSkills(
  skills: readonly CustomSkill[],
  stagingRoot: string,
  saveSkill: (skill: CustomSkill) => void,
  current?: (name: string) => CustomSkill | undefined,
): Promise<KeepCurrentResult[]> {
  const out: KeepCurrentResult[] = []
  const live = new Set(await liveSkillFolders())
  const bySource = new Map<string, CustomSkill[]>()
  for (const skill of skills) {
    if (skill.enabled && live.has(skill.name)) {
      bySource.set(skill.sourceUrl, [...(bySource.get(skill.sourceUrl) ?? []), skill])
    }
  }
  for (const [url, group] of bySource) {
    let remote: Awaited<ReturnType<typeof remoteSkillShas>>
    try {
      remote = await remoteSkillShas(url)
    } catch (error) {
      for (const skill of group) out.push(entry('skill', skill.name, 'failed', errorText(error)))
      continue
    }
    for (const skill of group) {
      try {
        const staged = await folderShas(join(stagingRoot, skill.name))
        if (sameFiles(remote(skill.sourcePath), staged)) {
          out.push(entry('skill', skill.name, 'current', 'No change at its source.'))
          continue
        }
        if (!sameFiles(ownFiles(await folderShas(join(liveSkillsRoot(), skill.name))), ownFiles(staged))) {
          out.push(
            entry('skill', skill.name, 'failed', 'Its copy in .claude/skills has changes of your own, so it was left as it is.'),
          )
          continue
        }
        const others = new Set([...live].filter((name) => name !== skill.name))
        const fresh = (await importSkills(url, stagingRoot, others, skill.name)).imported.find(
          (imported) => imported.name === skill.name,
        )
        if (!fresh) {
          out.push(entry('skill', skill.name, 'failed', 'Its source no longer has a skill of that name.'))
          continue
        }
        if (current && !current(skill.name)?.enabled) continue
        saveSkill(fresh)
        await enableSkill(stagingRoot, skill.name)
        out.push(entry('skill', skill.name, 'updated', `${fresh.fileCount} files from its source.`))
      } catch (error) {
        out.push(entry('skill', skill.name, 'failed', errorText(error)))
      }
    }
  }
  return out
}

function onPath(name: string): string | null {
  const exe = process.platform === 'win32' ? `${name}.exe` : name
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, exe))) return join(dir, exe)
  }
  return null
}

export function keepCurrentService(deps: {
  repos: Repositories
  stagingRoot: string
  run?: CommandRunner
  onReport?: (report: KeepCurrentReport) => void
}): { check: () => Promise<KeepCurrentReport>; schedule: () => () => void } {
  const run = deps.run ?? runCommand
  let running: Promise<KeepCurrentReport> | null = null

  const check = (): Promise<KeepCurrentReport> => {
    running ??= (async () => {
      const claude = resolveClaudeExecutable()
      const uvx = onPath('uvx')
      const results = [
        ...(claude
          ? await updatePlugins(run, claude)
          : [entry('plugin', 'Claude Code', 'failed', 'Claude Code was not found, so no plugin was checked.')]),
        ...(await refreshSkills(
          deps.repos.customSkills.list(),
          deps.stagingRoot,
          (skill) => deps.repos.customSkills.upsertMany([skill]),
          (name) => deps.repos.customSkills.byName(name),
        )),
        ...(uvx ? await updateSpecKit(run, uvx, deps.repos.projects.listActive()) : []),
      ]
      const report = { checkedAt: new Date().toISOString(), results }
      deps.repos.settings.set({ keepCurrentLast: report })
      deps.onReport?.(report)
      return report
    })().finally(() => {
      running = null
    })
    return running
  }

  const schedule = (): (() => void) => {
    const tick = (): void => {
      if (deps.repos.settings.get().keepCurrent) check().catch(() => {})
    }
    const first = setTimeout(tick, START_DELAY_MS)
    const daily = setInterval(tick, DAY_MS)
    return () => {
      clearTimeout(first)
      clearInterval(daily)
    }
  }

  return { check, schedule }
}
