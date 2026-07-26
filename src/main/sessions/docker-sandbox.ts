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
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import type { SpawnOptions as SdkSpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk'

const execFileAsync = promisify(execFile)

const IMAGE = 'switchboard-sandbox'
const NAME_PREFIX = 'swb-'
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
const DOCKERFILE = `FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep ca-certificates && rm -rf /var/lib/apt/lists/* \\
 && npm install -g @anthropic-ai/claude-code \\
 && printf '#!/bin/sh\\nmkdir -p "$HOME/.claude"\\n[ -f /creds/.credentials.json ] && cp /creds/.credentials.json "$HOME/.claude/.credentials.json"\\nexec "$@"\\n' > /entrypoint.sh \\
 && chmod +x /entrypoint.sh \\
 && mkdir -p /home/node/.claude && chown -R node:node /home/node/.claude
USER node
ENV HOME=/home/node
WORKDIR /workspace
ENTRYPOINT ["/entrypoint.sh"]
`

function credsPath(): string {
  return join(homedir(), '.claude', '.credentials.json')
}

/**
 * Fail-closed readiness check before a bypass session starts: Docker daemon up,
 * host login present, image built (first build downloads ~200 MB, minutes).
 * Throws with a message the session-start error path shows verbatim.
 */
export async function ensureSandboxImage(): Promise<void> {
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
    await execFileAsync('docker', ['image', 'inspect', IMAGE], { windowsHide: true, timeout: 15_000 })
    return
  } catch {
    // Image missing — build it (cached after the first time).
  }
  await new Promise<void>((resolve, reject) => {
    const build = spawn('docker', ['build', '-t', IMAGE, '-'], {
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe'],
      timeout: 600_000,
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
    build.stdin.end(DOCKERFILE)
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

export interface SandboxPlan {
  /** Container-side paths to hand the SDK as additionalDirectories (--add-dir). */
  additionalDirectories: string[]
  /** Drop-in for the SDK's spawnClaudeCodeProcess option. */
  spawn: (options: SdkSpawnOptions) => SpawnedProcess
}

export function sandboxSpawn(config: {
  sessionId: string
  projectId: string
  projectPath: string
  refDirs: string[]
}): SandboxPlan {
  // REFS chips mount read-only under /refs/<basename>; duplicates get an index.
  const refMounts: { host: string; container: string }[] = []
  const seen = new Set<string>()
  for (const dir of config.refDirs) {
    let name = basename(dir) || 'ref'
    if (seen.has(name)) name = `${name}-${refMounts.length}`
    seen.add(name)
    refMounts.push({ host: dir, container: `/refs/${name}` })
  }
  const safe = (value: string): string => value.replace(/[^a-zA-Z0-9_.-]/g, '')
  const containerName = `${NAME_PREFIX}${safe(config.sessionId)}`
  const homeVolume = `${HOME_VOLUME_PREFIX}${safe(config.projectId)}`
  return {
    additionalDirectories: ['/workspace', ...refMounts.map((r) => r.container)],
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
        ...refMounts.flatMap((r) => ['-v', `${r.host}:${r.container}:ro`]),
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
        IMAGE,
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
