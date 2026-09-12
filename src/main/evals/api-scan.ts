import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { scanEndpoints, type ApiTarget, type DiscoveredEndpoint } from '@shared/api-endpoints'

const SKIP = new Set([
  'node_modules',
  '.git',
  'bin',
  'obj',
  'dist',
  'out',
  'release',
  '.vs',
  '.vscode',
  '.idea',
  'coverage',
  'TestResults',
  '.angular',
  '.next',
  '.nuxt',
  'packages',
  'wwwroot',
])

const EXTENSIONS = ['.cs', '.http', '.ts', '.js']

const MAX_FILES = 1500
const MAX_DEPTH = 8
const MAX_BYTES = 512 * 1024

export async function scanProjectEndpoints(root: string): Promise<{
  endpoints: DiscoveredEndpoint[]
  filesRead: number
  truncated: boolean
}> {
  const files: { path: string; text: string }[] = []
  let truncated = false

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES) return
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (files.length >= MAX_FILES) {
        truncated = true
        return
      }
      if (SKIP.has(name) || name.startsWith('.')) continue
      const full = join(dir, name)
      let stats
      try {
        stats = await stat(full)
      } catch {
        continue
      }
      if (stats.isDirectory()) {
        await walk(full, depth + 1)
        continue
      }
      if (!EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext))) continue
      if (stats.size > MAX_BYTES) continue
      try {
        files.push({
          path: relative(root, full).split(sep).join('/'),
          text: await readFile(full, 'utf8'),
        })
      } catch {
      }
    }
  }

  await walk(root, 0)
  return { endpoints: scanEndpoints(files), filesRead: files.length, truncated }
}

export interface ApiHost {
  baseUrl: string
  startCmd: string | null
  cwd: string
  from: string
  target: ApiTarget
  headers: Record<string, string> | null
}

export function resolveHeaders(
  text: string | undefined,
  env: Record<string, string | undefined>,
): { headers: Record<string, string> | null } | { error: string } {
  const lines = (text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return { headers: null }
  const headers: Record<string, string> = {}
  const missing: string[] = []
  for (const line of lines) {
    const at = line.indexOf(':')
    if (at <= 0) continue
    const name = line.slice(0, at).trim()
    const value = line.slice(at + 1).trim()
    headers[name] = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_whole, variable: string) => {
      const found = env[variable]
      if (found === undefined || found === '') {
        missing.push(variable)
        return ''
      }
      return found
    })
  }
  if (missing.length > 0) {
    return {
      error:
        `The header for this environment references ${[...new Set(missing)].join(', ')}, which ` +
        'is not set in this process. Set it where Switchboard is launched from and try again — ' +
        'the value itself is never stored here.',
    }
  }
  return { headers: Object.keys(headers).length > 0 ? headers : null }
}

export async function resolveApiHost(
  root: string,
  override: {
    baseUrl?: string
    startCmd?: string
    target?: ApiTarget
    qaBaseUrl?: string
    qaHeaders?: string
    env?: Record<string, string | undefined>
  },
): Promise<ApiHost | { error: string }> {
  if (override.target === 'qa') {
    const qaUrl = override.qaBaseUrl?.trim().replace(/\/+$/, '') || null
    if (!qaUrl) {
      return {
        error:
          'No QA URL set for this project. Add one in the API panel — a deployed environment is never guessed.',
      }
    }
    const resolved = resolveHeaders(override.qaHeaders, override.env ?? process.env)
    if ('error' in resolved) return resolved
    return {
      baseUrl: qaUrl,
      startCmd: null,
      cwd: root,
      from: 'the QA URL set for this project',
      target: 'qa',
      headers: resolved.headers,
    }
  }
  const chosenUrl = override.baseUrl?.trim().replace(/\/+$/, '') || null
  const chosenCmd = override.startCmd?.trim() || null
  const launch = await findLaunchSettings(root)
  const baseUrl = chosenUrl ?? launch?.url ?? null
  if (!baseUrl) {
    return {
      error:
        'No base URL for this project. Set one in the API panel, with a start command if the app is not already running. A port is never guessed.',
    }
  }
  return {
    baseUrl,
    startCmd: chosenCmd ?? (launch ? `dotnet run --project "${launch.projectDir}"` : null),
    cwd: root,
    from: chosenUrl
      ? 'the base URL set for this project'
      : `${(launch as LaunchSettings).source} (profile ${(launch as LaunchSettings).profile})`,
    target: 'local',
    headers: null,
  }
}

interface LaunchSettings {
  url: string
  profile: string
  projectDir: string
  source: string
}

async function findLaunchSettings(root: string): Promise<LaunchSettings | null> {
  const depth = 4
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }]
  while (queue.length > 0) {
    const { dir, depth: level } = queue.shift() as { dir: string; depth: number }
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      continue
    }
    if (entries.includes('launchSettings.json') && dir.toLowerCase().endsWith(`${sep}properties`)) {
      const parsed = await readLaunchProfile(join(dir, 'launchSettings.json'))
      if (parsed) {
        const projectDir = join(dir, '..')
        return {
          ...parsed,
          projectDir,
          source: relative(root, join(dir, 'launchSettings.json')).split(sep).join('/'),
        }
      }
    }
    if (level >= depth) continue
    for (const name of entries) {
      if (SKIP.has(name) || name.startsWith('.')) continue
      const full = join(dir, name)
      try {
        if ((await stat(full)).isDirectory()) queue.push({ dir: full, depth: level + 1 })
      } catch {
      }
    }
  }
  return null
}

async function readLaunchProfile(file: string): Promise<{ url: string; profile: string } | null> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
  const profiles =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as { profiles?: Record<string, { applicationUrl?: string }> }).profiles
      : undefined
  if (!profiles) return null
  for (const [profile, value] of Object.entries(profiles)) {
    const urls = value?.applicationUrl?.split(';').map((u) => u.trim()) ?? []
    const http = urls.find((u) => u.startsWith('http://'))
    if (http) return { url: http.replace(/\/+$/, ''), profile }
  }
  return null
}
