import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { cpus, homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { SpawnOptions as SdkSpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk'
import {
  detectStacks,
  needsBrowser,
  sandboxNeedsDotnet,
  sandboxTools,
  stackEntries,
  type SuiteTool,
} from '@shared/test-catalog'

const execFileAsync = promisify(execFile)

const WSLC = 'wslc'

const IMAGE = 'switchboard-sandbox'
const DOTNET_IMAGE = 'switchboard-sandbox-dotnet'
const BROWSER_SUFFIX = '-browser'
const BROWSER_VOLUME = 'switchboard-playwright'
const BROWSER_CACHE_PATH = '/home/node/.cache/ms-playwright'
const NAME_PREFIX = 'swb-'
const NUGET_VOLUME = 'switchboard-nuget'
const NODE_MODULES_VOLUME_PREFIX = 'switchboard-node-modules-'
const NPM_CACHE_VOLUME = 'switchboard-npm-cache'
const HOME_VOLUME_PREFIX = 'switchboard-claude-home-'

export function homeVolumeFor(sessionId: string, resumeFromSessionId?: string): string {
  return `${HOME_VOLUME_PREFIX}${safeName(resumeFromSessionId ?? sessionId)}`
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '')
}

export function normalizeSize(value: string): string {
  const match = /^(\d+(?:\.\d+)?)\s*([kmgt])(i?b)?$/i.exec(value.trim())
  return match ? `${match[1]}${match[2].toUpperCase()}` : value.trim()
}

export function sandboxMemoryArg(setting?: string): string[] {
  const value = process.env.SWITCHBOARD_SANDBOX_MEMORY?.trim() || setting?.trim() || '6g'
  return value === '0' ? [] : ['--memory', normalizeSize(value)]
}

function mountPath(hostPath: string): string {
  return hostPath.replace(/\\/g, '/')
}

export function cpuShare(): string {
  return String(Math.max(2, Math.floor(cpus().length / 2)))
}

const SHARED_SETUP = `git ripgrep ca-certificates && rm -rf /var/lib/apt/lists/* \\
 && npm install -g @anthropic-ai/claude-code \\
 && printf '#!/bin/sh\\nmkdir -p "$HOME/.claude"\\n[ -f /creds/.credentials.json ] && cp /creds/.credentials.json "$HOME/.claude/.credentials.json"\\n[ -d /creds/plugins ] && mkdir -p "$HOME/.claude/plugins" && cp -r /creds/plugins/. "$HOME/.claude/plugins/"\\n[ -d /creds/skills ] && mkdir -p "$HOME/.claude/skills" && cp -r /creds/skills/. "$HOME/.claude/skills/"\\nexec "$@"\\n' > /entrypoint.sh \\
 && chmod +x /entrypoint.sh`

function browserLayer(browser: boolean): string {
  if (!browser) return ''
  return (
    ` \\\n && npx --yes playwright@1 install-deps chromium` +
    ` \\\n && rm -rf /var/lib/apt/lists/*` +
    ` \\\n && mkdir -p ${BROWSER_CACHE_PATH} && chown -R node:node ${BROWSER_CACHE_PATH}`
  )
}

function browserEnv(browser: boolean): string {
  return browser ? `ENV PLAYWRIGHT_BROWSERS_PATH=${BROWSER_CACHE_PATH}\n` : ''
}

const containerfile = (browser: boolean): string => `FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends ${SHARED_SETUP} \\
 && mkdir -p /home/node/.claude && chown -R node:node /home/node/.claude${browserLayer(browser)}
USER node
ENV HOME=/home/node
${browserEnv(browser)}WORKDIR /workspace
ENTRYPOINT ["/entrypoint.sh"]
`

const dotnetContainerfile = (browser: boolean): string => `FROM mcr.microsoft.com/dotnet/sdk:10.0
COPY --from=node:22-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:22-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \\
 && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \\
 && apt-get update && apt-get install -y --no-install-recommends ${SHARED_SETUP} \\
 && useradd -m -o -u 1000 node \\
 && mkdir -p /home/node/.claude /home/node/.nuget/packages \\
 && chown -R node:node /home/node${browserLayer(browser)}
USER node
ENV HOME=/home/node
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1
ENV DOTNET_NOLOGO=1
ENV MSBUILDDISABLENODEREUSE=1
ENV UseSharedCompilation=false
ENV PATH="/home/node/.dotnet/tools:\${PATH}"
# The catalogue offers "dotnet stryker" as the mutation suite, so the image it
# runs in has to have it. Without this the suite reported the developer's code
# as failing when the truth was that the tool was never installed, which is the
# exact confusion FR-057 exists to prevent. Installed as the node user so it
# lands in the HOME above, and pinned to a major version so an image rebuilt
# months from now does not quietly change what the suite measures.
RUN dotnet tool install --global dotnet-stryker --version "4.*"
USER root
# The SDK image carries ONLY its own runtime, and a project's target framework is
# not the SDK's version. A net8.0 test project builds fine under the 10 SDK and
# then cannot RUN: VSTest starts a net8.0 test host, no 8.0 runtime exists, the
# host dies before reporting, and every tool downstream sees an empty result set.
#
# Stryker's own words for that were "No test result reported. Make sure your test
# project contains test and is compatible with VsTest", on a project holding 35
# tests it had just counted — which reads as the tests being broken and is really
# a missing runtime. \`dotnet test\` gives an equally indirect answer.
#
# ASP.NET Core rather than the bare runtime because it is a superset: a web
# project needs it and a class library does not care. Add another --channel line
# here for any framework a project in this app actually targets; each is about
# 100 MB, so they are added on evidence rather than in advance.
RUN apt-get update && apt-get install -y --no-install-recommends curl \\
 && rm -rf /var/lib/apt/lists/* \\
 && curl -sSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh \\
 && bash /tmp/dotnet-install.sh --channel 8.0 --runtime aspnetcore --install-dir /usr/share/dotnet --no-path \\
 && rm /tmp/dotnet-install.sh
USER node
${browserEnv(browser)}WORKDIR /workspace
ENTRYPOINT ["/entrypoint.sh"]
`

function imageFor(projectPath: string): {
  image: string
  dotnet: boolean
  browser: boolean
  node: boolean
} {
  let dotnet = false
  let browser = false
  const node = existsSync(join(projectPath, 'package.json'))
  try {
    const entries = stackEntries(projectPath, (dir) => readdirSync(dir))
    dotnet = sandboxNeedsDotnet(detectStacks(entries))
    browser = needsBrowser(entries, (entry) => {
      try {
        return readFileSync(join(projectPath, entry), 'utf8')
      } catch {
        return null
      }
    })
  } catch {
  }
  const base = dotnet ? DOTNET_IMAGE : IMAGE
  const name = browser ? base + BROWSER_SUFFIX : base
  return { image: `${name}:${recipeTag(dotnet, browser)}`, dotnet, browser, node }
}

export function recipeTag(dotnet: boolean, browser: boolean): string {
  const recipe = dotnet ? dotnetContainerfile(browser) : containerfile(browser)
  return createHash('sha256').update(recipe).digest('hex').slice(0, 12)
}

export function sandboxImageFor(projectPath: string): string {
  return imageFor(projectPath).image
}

export function sandboxToolsFor(projectPath: string): readonly SuiteTool[] {
  const { dotnet, browser } = imageFor(projectPath)
  return sandboxTools(dotnet, browser)
}

const GIT_CACHE_TTL_MS = 30_000

function memoizeGitRead<T>(fn: (projectPath: string) => T): (projectPath: string) => T {
  const cache = new Map<string, { value: T; expiresAt: number }>()
  return (projectPath: string): T => {
    const now = Date.now()
    const hit = cache.get(projectPath)
    if (hit && hit.expiresAt > now) return hit.value
    const value = fn(projectPath)
    cache.set(projectPath, { value, expiresAt: now + GIT_CACHE_TTL_MS })
    return value
  }
}

function gitRootImpl(projectPath: string): string | null {
  try {
    if (existsSync(join(projectPath, '.git'))) return projectPath
    const sub = readdirSync(projectPath, { withFileTypes: true }).find(
      (entry) => entry.isDirectory() && existsSync(join(projectPath, entry.name, '.git')),
    )
    return sub ? join(projectPath, sub.name) : null
  } catch {
    return null
  }
}

function gitNoticeImpl(projectPath: string): string | null {
  try {
    const dotGit = join(projectPath, '.git')
    if (existsSync(dotGit)) {
      if (statSync(dotGit).isDirectory()) return null
      return (
        '.git here is a worktree/submodule pointer file whose real git directory is ' +
        'outside the container mount — git will not work in this session.'
      )
    }
    for (let dir = dirname(projectPath), prev = projectPath; dir !== prev; prev = dir, dir = dirname(dir)) {
      if (existsSync(join(dir, '.git'))) {
        return (
          `The project folder sits inside the repository at ${dir}, which is ` +
          'outside the container mount — git history is not visible in this session.'
        )
      }
    }
    const sub = readdirSync(projectPath, { withFileTypes: true }).find(
      (entry) => entry.isDirectory() && existsSync(join(projectPath, entry.name, '.git')),
    )
    if (sub) {
      return (
        `The project root is not a git repository; the repository lives at ./${sub.name} — ` +
        'run git commands from there.'
      )
    }
    return 'The project is not a git repository — there is no git history to diff.'
  } catch {
    return null
  }
}

export const gitRoot = memoizeGitRead(gitRootImpl)
export const gitNotice = memoizeGitRead(gitNoticeImpl)

function credsPath(): string {
  return join(homedir(), '.claude', '.credentials.json')
}

function pluginsPath(): string {
  return join(homedir(), '.claude', 'plugins')
}

function skillsPath(): string {
  return join(homedir(), '.claude', 'skills')
}

const buildingImages = new Map<string, Promise<void>>()

function buildContextDir(): string {
  const dir = join(tmpdir(), 'switchboard-build')
  mkdirSync(dir, { recursive: true })
  return dir
}

export async function ensureSandboxImage(projectPath: string): Promise<void> {
  const { image, dotnet, browser } = imageFor(projectPath)
  if (!existsSync(credsPath())) {
    throw new Error(
      'Claude Code login not found (~/.claude/.credentials.json). Log in with the claude CLI once, then retry.',
    )
  }
  try {
    await execFileAsync(WSLC, ['version'], { windowsHide: true, timeout: 15_000 })
  } catch {
    throw new Error(
      'WSL container (wslc) was not found. Containerised sessions run on it, and it needs WSL 2.9.3 or newer: run `wsl --update --pre-release` in PowerShell. If you have already done that, restart Switchboard: wslc is added to PATH by the installer and this process cannot see it until it restarts.',
    )
  }
  try {
    await execFileAsync(WSLC, ['image', 'inspect', image], { windowsHide: true, timeout: 15_000 })
    return
  } catch {
  }
  const existing = buildingImages.get(image)
  if (existing) {
    await existing
    return
  }
  const build = new Promise<void>((resolve, reject) => {
    const proc = spawn(WSLC, ['build', '-t', image, '-f', '-', buildContextDir()], {
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe'],
      timeout: dotnet ? 2_400_000 : browser ? 1_200_000 : 600_000,
    })
    let stderr = ''
    proc.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    proc.on('error', reject)
    proc.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Sandbox image build failed: ${stderr.slice(-400)}`))
    })
    proc.stdin.end(dotnet ? dotnetContainerfile(browser) : containerfile(browser))
  })
  buildingImages.set(image, build)
  try {
    await build
  } finally {
    buildingImages.delete(image)
  }
}

export async function ensureSandboxVolumes(names: readonly string[]): Promise<void> {
  await Promise.all(
    names.map((name) =>
      execFileAsync(WSLC, ['volume', 'create', name], {
        windowsHide: true,
        timeout: 30_000,
      }).catch(() => undefined),
    ),
  )
}

export function sweepOrphanedContainers(sessionIds: readonly string[]): void {
  for (const id of sessionIds) {
    execFile(
      WSLC,
      ['container', 'remove', '--force', `${NAME_PREFIX}${safeName(id)}`],
      { windowsHide: true },
      () => {},
    )
  }
}

export function removeNodeModulesVolume(sessionId: string): void {
  execFile(
    WSLC,
    ['volume', 'remove', '--force', `${NODE_MODULES_VOLUME_PREFIX}${safeName(sessionId)}`],
    { windowsHide: true },
    () => {},
  )
}

const STALE_VOLUME_AGE_MS = 7 * 24 * 60 * 60 * 1000

export function sweepStaleVolumes(
  sessionById: (sessionId: string) => { endedAt: string | null } | undefined,
): void {
  execFile(WSLC, ['volume', 'list', '--quiet'], { windowsHide: true }, (error, stdout) => {
    if (error) return
    const stale: string[] = []
    for (const name of stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
      const prefix = name.startsWith(HOME_VOLUME_PREFIX)
        ? HOME_VOLUME_PREFIX
        : name.startsWith(NODE_MODULES_VOLUME_PREFIX)
          ? NODE_MODULES_VOLUME_PREFIX
          : null
      if (!prefix) continue
      const session = sessionById(name.slice(prefix.length))
      if (!session) {
        stale.push(name)
        continue
      }
      if (session.endedAt === null) continue 
      if (Date.now() - Date.parse(session.endedAt) > STALE_VOLUME_AGE_MS) stale.push(name)
    }
    for (const name of stale) {
      execFile(WSLC, ['volume', 'remove', '--force', name], { windowsHide: true }, () => {})
    }
  })
}

interface Mount {
  host: string
  container: string
}

export function sandboxVolumeNames(config: {
  projectPath: string
  sessionId: string
  resumeFromSessionId: string | undefined
  nodeModulesVolumeKey?: string
}): string[] {
  const { dotnet, browser, node } = imageFor(config.projectPath)
  return [
    homeVolumeFor(config.sessionId, config.resumeFromSessionId),
    ...(dotnet ? [NUGET_VOLUME] : []),
    ...(node
      ? [
          `${NODE_MODULES_VOLUME_PREFIX}${safeName(config.nodeModulesVolumeKey ?? config.sessionId)}`,
          NPM_CACHE_VOLUME,
        ]
      : []),
    ...(browser ? [BROWSER_VOLUME] : []),
  ]
}

export interface SandboxPlan {
  additionalDirectories: string[]
  mounts: Mount[]
  spawn: (options: SdkSpawnOptions) => SpawnedProcess
  lastStderr: () => string
}

export function hasNodeModulesVolume(projectPath: string): boolean {
  return imageFor(projectPath).node
}

export function refMounts(refDirs: readonly string[]): Mount[] {
  const mounts: Mount[] = []
  const seen = new Set<string>()
  for (const dir of refDirs) {
    let name = basename(dir) || 'ref'
    if (seen.has(name)) name = `${name}-${mounts.length}`
    seen.add(name)
    mounts.push({ host: dir, container: `/refs/${name}` })
  }
  return mounts
}

export function toContainerPaths(text: string, mounts: readonly Mount[]): string {
  const ordered = [...mounts].sort((a, b) => b.host.length - a.host.length)
  let out = text
  for (const { host, container } of ordered) {
    const pattern = host
      .replace(/[/\\]+$/, '')
      .replace(/[.*+?^${}()|[\]\\/]/g, (c) => (/[/\\]/.test(c) ? '[/\\\\]' : `\\${c}`))
    const re = new RegExp(`${pattern}((?:[/\\\\][^\\s"'\`)\\]]*)*)`, 'gi')
    out = out.replace(re, (_all, rest: string) => container + rest.replace(/\\/g, '/'))
  }
  return out
}

export function sandboxSpawn(config: {
  sessionId: string
  projectPath: string
  refDirs: string[]
  sandboxMemory?: string
  resumeFromSessionId: string | undefined
  nodeModulesVolumeKey?: string
}): SandboxPlan {
  const refs = refMounts(config.refDirs)
  const containerName = `${NAME_PREFIX}${safeName(config.sessionId)}`
  const homeVolume = homeVolumeFor(config.sessionId, config.resumeFromSessionId)
  const { image, dotnet, browser, node } = imageFor(config.projectPath)
  let stderrTail = ''
  return {
    additionalDirectories: ['/workspace', ...refs.map((r) => r.container)],
    mounts: [{ host: config.projectPath, container: '/workspace' }, ...refs],
    lastStderr: () => stderrTail,
    spawn: (options) => {
      const args = [
        'run',
        '-i',
        '--rm',
        '--name',
        containerName,
        '--volume',
        `${mountPath(config.projectPath)}:/workspace`,
        '--volume',
        `${homeVolume}:/home/node/.claude`,
        '--volume',
        `${mountPath(credsPath())}:/creds/.credentials.json:ro`,
        ...(existsSync(pluginsPath()) ? ['--volume', `${mountPath(pluginsPath())}:/creds/plugins:ro`] : []),
        ...(existsSync(skillsPath()) ? ['--volume', `${mountPath(skillsPath())}:/creds/skills:ro`] : []),
        ...(dotnet ? ['--volume', `${NUGET_VOLUME}:/home/node/.nuget/packages`] : []),
        ...(node
          ? [
              '--volume',
              `${NODE_MODULES_VOLUME_PREFIX}${safeName(config.nodeModulesVolumeKey ?? config.sessionId)}:/workspace/node_modules`,
              '--volume',
              `${NPM_CACHE_VOLUME}:/home/node/.npm`,
            ]
          : []),
        ...(browser ? ['--volume', `${BROWSER_VOLUME}:${BROWSER_CACHE_PATH}`] : []),
        ...refs.flatMap((r) => ['--volume', `${mountPath(r.host)}:${r.container}:ro`]),
        '--workdir',
        '/workspace',
        '--ulimit',
        'nproc=1024:1024',
        '--cpus',
        cpuShare(),
        ...(browser ? ['--shm-size', normalizeSize('512m')] : []),
        ...sandboxMemoryArg(config.sandboxMemory),
        '-e',
        'GIT_CONFIG_COUNT=1',
        '-e',
        'GIT_CONFIG_KEY_0=safe.directory',
        '-e',
        'GIT_CONFIG_VALUE_0=*',
        '-e',
        'DISABLE_AUTOUPDATER=1',
        ...Object.entries(options.env ?? {})
          .filter(([k, v]) => v !== undefined && /^(CLAUDE|ANTHROPIC)/.test(k) && !/^[A-Za-z]:\\/.test(String(v)))
          .flatMap(([k, v]) => ['-e', `${k}=${v}`]),
        image,
        'claude',
        ...options.args,
      ]
      const child: ChildProcess = spawn(WSLC, args, {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        signal: options.signal,
      })
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-2000)
      })
      child.on('exit', (code) => {
        if (code) console.error(`[sandbox ${containerName}] wslc exited ${code}: ${stderrTail.trim()}`)
      })
      const killContainer = (): void => {
        execFile(WSLC, ['kill', containerName], { windowsHide: true }, () => {})
      }
      options.signal?.addEventListener('abort', killContainer, { once: true })
      const clientKill = child.kill.bind(child)
      child.kill = (signal?: number | NodeJS.Signals) => {
        killContainer()
        return clientKill(signal)
      }
      return child as SpawnedProcess
    },
  }
}
