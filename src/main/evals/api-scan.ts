// Finding a project's endpoints, and finding where to call them.
//
// Both answers come from the project's own files, so the API panel is populated
// before anything is started and without asking a model what the routes are.
import { readdirSync, readFileSync, statSync } from 'node:fs'
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

/** Files worth reading: where routes are declared, and nothing else. */
const EXTENSIONS = ['.cs', '.http', '.ts', '.js']

/** Bounds, so a scan of a large monorepo stays a keystroke rather than a wait. */
const MAX_FILES = 1500
const MAX_DEPTH = 8
const MAX_BYTES = 512 * 1024

/**
 * Every route declared under `root`, with the file and line it came from.
 *
 * Deliberately bounded rather than exhaustive: past MAX_FILES the scan stops and
 * says how many files it read, because a truncated list the developer can search
 * is useful and a five-second scan of a monorepo is not.
 */
export function scanProjectEndpoints(root: string): {
  endpoints: DiscoveredEndpoint[]
  filesRead: number
  truncated: boolean
} {
  const files: { path: string; text: string }[] = []
  let truncated = false

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
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
        stats = statSync(full)
      } catch {
        continue
      }
      if (stats.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      if (!EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext))) continue
      if (stats.size > MAX_BYTES) continue
      try {
        files.push({
          path: relative(root, full).split(sep).join('/'),
          text: readFileSync(full, 'utf8'),
        })
      } catch {
        // Unreadable file: a scan is a convenience, never a blocker.
      }
    }
  }

  walk(root, 0)
  return { endpoints: scanEndpoints(files), filesRead: files.length, truncated }
}

/** Where the run sends its calls, and how to get the server up if it is not. */
export interface ApiHost {
  baseUrl: string
  /** Shell command that starts the API, or null when it must already be running. */
  startCmd: string | null
  /** Working directory for `startCmd`. */
  cwd: string
  /** Where these values came from, shown in the panel so nothing is magic. */
  from: string
  /** Which environment this is, so the run knows what it may do to it. */
  target: ApiTarget
  /**
   * Headers every call carries, already resolved — the deployed environment's API
   * key, typically. Null for a local run, which needs none.
   */
  headers: Record<string, string> | null
}

/**
 * `Name: value` lines with `${VAR}` resolved from the environment.
 *
 * Unresolved is an ERROR, never a header sent as written. A literal `${QA_API_KEY}`
 * would reach the environment as an API key, be rejected, and the whole run would
 * read as "QA rejects every call" when the real fault is a variable that is not
 * set in this process. Naming the variable is the difference between a five-second
 * fix and an afternoon.
 */
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

/**
 * Resolve the base URL to call and the command that starts the API.
 *
 * The project's own launchSettings.json is the authority, because it is what the
 * developer already runs with — the port in it is the port the API listens on.
 * ASPNETCORE_URLS is then forced to that same URL when the run launches the API,
 * so the port is a fact rather than a hope. An explicit setting always wins, and
 * when neither exists the failure is a sentence asking for a base URL, never a
 * guessed port.
 */
export function resolveApiHost(
  root: string,
  override: {
    baseUrl?: string
    startCmd?: string
    /** 'qa' resolves the deployed environment instead of the local one. */
    target?: ApiTarget
    /** The QA base URL for this project, and the headers it needs. */
    qaBaseUrl?: string
    qaHeaders?: string
    /** Process environment the `${VAR}` references resolve against. */
    env?: Record<string, string | undefined>
  },
): ApiHost | { error: string } {
  // A deployed environment is resolved on its own terms and nothing else's: no
  // launchSettings fallback, no start command, so there is no path by which a run
  // against QA can start a server. That is a safety property of this branch being
  // separate, not a detail of it.
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
  // Looked up even when a base URL is set: a developer who typed a URL still
  // wants the API started for them, and launchSettings is where the command
  // that starts it comes from.
  const launch = findLaunchSettings(root)
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

/**
 * The first launchSettings.json under the root holding an http:// applicationUrl.
 *
 * http rather than https on purpose: a dev HTTPS certificate the run does not
 * trust fails in a way that reads as the API being broken when it is not.
 */
function findLaunchSettings(root: string, depth = 4): LaunchSettings | null {
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }]
  while (queue.length > 0) {
    const { dir, depth: level } = queue.shift() as { dir: string; depth: number }
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    if (entries.includes('launchSettings.json') && dir.toLowerCase().endsWith(`${sep}properties`)) {
      const parsed = readLaunchProfile(join(dir, 'launchSettings.json'))
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
        if (statSync(full).isDirectory()) queue.push({ dir: full, depth: level + 1 })
      } catch {
        // Not a directory, or gone since the listing.
      }
    }
  }
  return null
}

function readLaunchProfile(file: string): { url: string; profile: string } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
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
