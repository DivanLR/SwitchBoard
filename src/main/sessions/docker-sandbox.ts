// Bypass-permission sessions run the Claude CLI inside a disposable Linux
// container (docker run --rm) instead of natively. Claude Code's own OS
// sandbox does not exist on native Windows, so the container is the isolation
// boundary: full autonomy inside, while the host only exposes the project
// folder (rw) and referenced folders (ro).
//
// Auth: the host's OAuth credentials file is mounted read-only and copied into
// the container home by the image's entrypoint, so no login step is needed
// inside the container. A named volume persists the container-side ~/.claude
// between runs (transcripts, so bypass→bypass resume works).
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import type { SpawnOptions as SdkSpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk'
import { detectStacks, sandboxNeedsDotnet, sandboxTools, type SuiteTool } from '@shared/test-catalog'

const execFileAsync = promisify(execFile)

const IMAGE = 'switchboard-sandbox'
const DOTNET_IMAGE = 'switchboard-sandbox-dotnet'
const NAME_PREFIX = 'swb-'
// Restore cache, kept out of the container so `dotnet test` does not re-download
// every package on every session — containers are --rm, the volume is not.
const NUGET_VOLUME = 'switchboard-nuget'
// Per PROJECT, not global: the container's cwd is always /workspace, and the CLI
// derives its per-project storage key from cwd — so with one shared volume every
// project would collide on the same `projects/-workspace` directory and read each
// other's transcripts. A volume per project keeps the key unique where it lives,
// and keeps bypass→bypass resume working for that project.
const HOME_VOLUME_PREFIX = 'switchboard-claude-home-'

// Built via stdin (`docker build -`): no build context, nothing to package.
// ponytail: the CLI version is whatever npm had at image-build time; to pick
// up a newer CLI, `docker rmi switchboard-sandbox` and the next bypass session
// rebuilds.
//
// ponytail: two images, picked per project — node-only by default, node + the
// .NET SDK when the project's stack detection says .NET. Still no Python and no
// browser: those verification runs belong on the host, where the caches and test
// infrastructure already are. The Tests section reads the same answer through
// sandboxTools() in shared/test-catalog.ts and marks the rest unavailable up
// front — change both together if a toolchain is ever added here.
const SHARED_SETUP = `git ripgrep ca-certificates && rm -rf /var/lib/apt/lists/* \\
 && npm install -g @anthropic-ai/claude-code \\
 && printf '#!/bin/sh\\nmkdir -p "$HOME/.claude"\\n[ -f /creds/.credentials.json ] && cp /creds/.credentials.json "$HOME/.claude/.credentials.json"\\nexec "$@"\\n' > /entrypoint.sh \\
 && chmod +x /entrypoint.sh`

const DOCKERFILE = `FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends ${SHARED_SETUP} \\
 && mkdir -p /home/node/.claude && chown -R node:node /home/node/.claude
USER node
ENV HOME=/home/node
WORKDIR /workspace
ENTRYPOINT ["/entrypoint.sh"]
`

// The .NET SDK image has no node, so node is copied in from the same node:22-slim
// the other image is built on — one node version to reason about, and no second
// apt repository to keep working.
//
// `node` is created at uid 1000 with -o (non-unique): the SDK image is Ubuntu and
// already parks its own `ubuntu` user there. The uid is what matters, not the
// name — a project that gains a .sln flips to this image and must still write the
// ~/.claude volume the node-only image created as uid 1000.
const DOTNET_DOCKERFILE = `FROM mcr.microsoft.com/dotnet/sdk:10.0
COPY --from=node:22-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:22-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \\
 && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \\
 && apt-get update && apt-get install -y --no-install-recommends ${SHARED_SETUP} \\
 && useradd -m -o -u 1000 node \\
 && mkdir -p /home/node/.claude /home/node/.nuget/packages \\
 && chown -R node:node /home/node
USER node
ENV HOME=/home/node
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1
ENV DOTNET_NOLOGO=1
WORKDIR /workspace
ENTRYPOINT ["/entrypoint.sh"]
`

/**
 * Which image this project needs, from the same stack detection the Tests
 * section shows. Unreadable folder → the small image: a wrong guess there costs
 * a "dotnet is not in the bypass container" message, not a broken session.
 */
export function imageFor(projectPath: string): { image: string; dotnet: boolean } {
  let dotnet: boolean
  try {
    dotnet = sandboxNeedsDotnet(detectStacks(readdirSync(projectPath)))
  } catch {
    dotnet = false
  }
  return { image: dotnet ? DOTNET_IMAGE : IMAGE, dotnet }
}

/** What a bypass session for this project can run, from the very same detection
 *  that picks the image — so the two can never disagree. */
export function sandboxToolsFor(projectPath: string): readonly SuiteTool[] {
  return sandboxTools(imageFor(projectPath).dotnet)
}

function credsPath(): string {
  return join(homedir(), '.claude', '.credentials.json')
}

/**
 * Fail-closed readiness check before a bypass session starts: Docker daemon up,
 * host login present, image built (first build downloads ~200 MB, minutes).
 * Throws with a message the session-start error path shows verbatim.
 */
export async function ensureSandboxImage(projectPath: string): Promise<void> {
  const { image, dotnet } = imageFor(projectPath)
  if (!existsSync(credsPath())) {
    throw new Error(
      'Claude Code login not found (~/.claude/.credentials.json). Log in with the claude CLI once, then retry.',
    )
  }
  try {
    await execFileAsync('docker', ['version', '--format', '{{.Server.Version}}'], {
      windowsHide: true,
      timeout: 15_000,
    })
  } catch {
    throw new Error(
      'Docker Desktop is not running. Bypass sessions run inside a container — start Docker Desktop, then retry.',
    )
  }
  try {
    await execFileAsync('docker', ['image', 'inspect', image], { windowsHide: true, timeout: 15_000 })
    return
  } catch {
    // Image missing — build it (cached after the first time).
  }
  await new Promise<void>((resolve, reject) => {
    const build = spawn('docker', ['build', '-t', image, '-'], {
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe'],
      // The .NET SDK layer is ~1 GB to pull; 10 minutes is not enough on a slow
      // link, and timing out here strands the developer with a half-built image.
      timeout: dotnet ? 2_400_000 : 600_000,
    })
    let stderr = ''
    build.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    build.on('error', reject)
    build.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Sandbox image build failed: ${stderr.slice(-400)}`))
    })
    build.stdin.end(dotnet ? DOTNET_DOCKERFILE : DOCKERFILE)
  })
}

/**
 * Remove containers a previous run left behind. The in-process teardown can
 * never run when the app is killed hard (crash, Task Manager, power loss), so
 * without this sweep an orphaned bypass container keeps running — with the
 * project bind-mounted read-write — and nothing would ever reap it.
 * Fire-and-forget: silent when Docker is absent, and never blocks startup.
 */
export function sweepOrphanedContainers(): void {
  execFile(
    'docker',
    ['ps', '-aq', '--filter', `name=^${NAME_PREFIX}`],
    { windowsHide: true },
    (error, stdout) => {
      if (error) return
      const ids = stdout.split('\n').map((line) => line.trim()).filter(Boolean)
      if (ids.length > 0) execFile('docker', ['rm', '-f', ...ids], { windowsHide: true }, () => {})
    },
  )
}

export interface Mount {
  host: string
  container: string
}

export interface SandboxPlan {
  /** Container-side paths to hand the SDK as additionalDirectories (--add-dir). */
  additionalDirectories: string[]
  /** Every host→container mapping, longest host path first. The session rewrites
   *  outgoing message text through these, and the manager describes them to the
   *  agent — a Windows path means nothing inside the container. */
  mounts: Mount[]
  /** Drop-in for the SDK's spawnClaudeCodeProcess option. */
  spawn: (options: SdkSpawnOptions) => SpawnedProcess
}

/** REFS chips mount read-only under /refs/<basename>; duplicates get an index. */
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

/**
 * Rewrite host paths in text to their container-side mounts.
 *
 * The composer appends `@<host path>` for every REFS chip, and a developer
 * pastes Windows paths freely — inside the container none of those exist, so the
 * agent hunts for `/mnt/c/...`, finds nothing, and reports the repo unreachable.
 * Translating on the way in fixes every source of a host path at once.
 *
 * Longest host path first, so a ref nested inside the project maps to the ref
 * rather than to /workspace. Matching is case-insensitive and treats `\` and `/`
 * as the same separator, because both spellings reach us.
 */
export function toContainerPaths(text: string, mounts: readonly Mount[]): string {
  const ordered = [...mounts].sort((a, b) => b.host.length - a.host.length)
  let out = text
  for (const { host, container } of ordered) {
    const pattern = host
      .replace(/[/\\]+$/, '')
      .replace(/[.*+?^${}()|[\]\\/]/g, (c) => (/[/\\]/.test(c) ? '[/\\\\]' : `\\${c}`))
    // Any following path segments come along, with their separators normalised.
    const re = new RegExp(`${pattern}((?:[/\\\\][^\\s"'\`)\\]]*)*)`, 'gi')
    out = out.replace(re, (_all, rest: string) => container + rest.replace(/\\/g, '/'))
  }
  return out
}

export function sandboxSpawn(config: {
  sessionId: string
  projectId: string
  projectPath: string
  refDirs: string[]
}): SandboxPlan {
  const refs = refMounts(config.refDirs)
  const safe = (value: string): string => value.replace(/[^a-zA-Z0-9_.-]/g, '')
  const containerName = `${NAME_PREFIX}${safe(config.sessionId)}`
  const homeVolume = `${HOME_VOLUME_PREFIX}${safe(config.projectId)}`
  const { image, dotnet } = imageFor(config.projectPath)
  return {
    additionalDirectories: ['/workspace', ...refs.map((r) => r.container)],
    mounts: [{ host: config.projectPath, container: '/workspace' }, ...refs],
    spawn: (options) => {
      const args = [
        'run',
        '-i',
        '--rm',
        '--init',
        '--name',
        containerName,
        '-v',
        `${config.projectPath}:/workspace`,
        '-v',
        `${homeVolume}:/home/node/.claude`,
        '-v',
        `${credsPath()}:/creds/.credentials.json:ro`,
        // Shared across projects on purpose: NuGet packages are immutable per
        // version, so one cache serves every .NET sandbox.
        ...(dotnet ? ['-v', `${NUGET_VOLUME}:/home/node/.nuget/packages`] : []),
        ...refs.flatMap((r) => ['-v', `${r.host}:${r.container}:ro`]),
        '-w',
        '/workspace',
        // The bind mount looks foreign-owned to git inside the container.
        '-e',
        'GIT_CONFIG_COUNT=1',
        '-e',
        'GIT_CONFIG_KEY_0=safe.directory',
        '-e',
        'GIT_CONFIG_VALUE_0=*',
        '-e',
        'DISABLE_AUTOUPDATER=1',
        // SDK control vars only — the rest of the host env is Windows-shaped.
        ...Object.entries(options.env ?? {})
          .filter(([k, v]) => v !== undefined && /^(CLAUDE|ANTHROPIC)/.test(k) && !/^[A-Za-z]:\\/.test(String(v)))
          .flatMap(([k, v]) => ['-e', `${k}=${v}`]),
        image,
        'claude',
        ...options.args,
      ]
      const child: ChildProcess = spawn('docker', args, {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        signal: options.signal,
      })
      // The SDK drains stderr only on its own spawn path (SpawnedProcess doesn't
      // even declare it), so a custom spawn MUST drain it here: an unread pipe
      // fills at ~64 KB and blocks the container mid-session. The tail is kept so
      // a failed `docker run` (mount denied, name conflict) isn't silent.
      let stderrTail = ''
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-2000)
      })
      child.on('exit', (code) => {
        if (code) console.error(`[sandbox ${containerName}] docker exited ${code}: ${stderrTail.trim()}`)
      })
      // Killing the docker CLIENT does not kill the container — do both, on
      // both kill paths (explicit kill() and the SDK's abort signal).
      const killContainer = (): void => {
        execFile('docker', ['kill', containerName], { windowsHide: true }, () => {})
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
