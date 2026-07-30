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
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
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

const IMAGE = 'switchboard-sandbox'
const DOTNET_IMAGE = 'switchboard-sandbox-dotnet'
/* Browser variants are separate images rather than a browser baked into every
   one. Chromium plus its shared libraries is a few hundred megabytes, and most
   projects here never drive a browser, so the cost is paid only where it buys
   something. Same reasoning that keeps the .NET SDK out of the small image. */
const BROWSER_SUFFIX = '-browser'
/* Chromium is immutable per version, so one cache serves every project, exactly
   like the NuGet volume. It is NOT baked into the image: the project's own
   Playwright decides which build it needs, and a version the image guessed at is
   worse than one the project downloaded for itself. */
const BROWSER_VOLUME = 'switchboard-playwright'
const BROWSER_CACHE_PATH = '/home/node/.cache/ms-playwright'
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
// Images are picked per project from what the project actually needs: node always,
// the .NET SDK when stack detection says .NET, and a browser's shared libraries when
// the project has real browser test infrastructure (needsBrowser() in
// shared/test-catalog.ts). That gives four possible images and each is built on
// first use.
//
// The browser is deliberately ABSENT for every other project, and that absence is
// the common case rather than a gap: a project with no Playwright config, no Karma
// config and no browser dependency gains nothing from several hundred megabytes of
// Chromium libraries in every session, so it does not get them. The Tests section
// reads the very same answer through sandboxToolsFor() and says "browser is not in
// the bypass container" up front, before a run, rather than failing one afterwards.
//
// Still no Python: nothing in the catalog needs it inside a container yet.
// The two answers must change together, here and in shared/test-catalog.ts.
const SHARED_SETUP = `git ripgrep ca-certificates && rm -rf /var/lib/apt/lists/* \\
 && npm install -g @anthropic-ai/claude-code \\
 && printf '#!/bin/sh\\nmkdir -p "$HOME/.claude"\\n[ -f /creds/.credentials.json ] && cp /creds/.credentials.json "$HOME/.claude/.credentials.json"\\nexec "$@"\\n' > /entrypoint.sh \\
 && chmod +x /entrypoint.sh`

/* Chromium needs a set of shared libraries that node:22-slim does not carry. This
   installs those libraries ONLY; the browser binary itself is fetched by the
   project's own Playwright into the shared cache volume, so the version always
   matches the project rather than whatever the image was built against. */
const BROWSER_LIBS = `libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \\
 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \\
 libgbm1 libpango-1.0-0 libcairo2 libasound2 libatspi2.0-0 fonts-liberation`

/**
 * The browser layer, or nothing at all.
 *
 * Only a project with real browser test infrastructure gets this; every other
 * project's image is built without it and is several hundred megabytes smaller.
 * Runs as root, before USER node, because installing shared libraries needs it.
 */
function browserLayer(browser: boolean): string {
  if (!browser) return ''
  return (
    ` \\\n && apt-get update && apt-get install -y --no-install-recommends ${BROWSER_LIBS}` +
    ` \\\n && rm -rf /var/lib/apt/lists/*` +
    ` \\\n && mkdir -p ${BROWSER_CACHE_PATH} && chown -R node:node ${BROWSER_CACHE_PATH}`
  )
}

/** PLAYWRIGHT_BROWSERS_PATH only exists on a browser image, so a project without
 *  one cannot silently download Chromium into a directory nothing persists. */
function browserEnv(browser: boolean): string {
  return browser ? `ENV PLAYWRIGHT_BROWSERS_PATH=${BROWSER_CACHE_PATH}\n` : ''
}

const dockerfile = (browser: boolean): string => `FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends ${SHARED_SETUP} \\
 && mkdir -p /home/node/.claude && chown -R node:node /home/node/.claude${browserLayer(browser)}
USER node
ENV HOME=/home/node
${browserEnv(browser)}WORKDIR /workspace
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
const dotnetDockerfile = (browser: boolean): string => `FROM mcr.microsoft.com/dotnet/sdk:10.0
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
${browserEnv(browser)}WORKDIR /workspace
ENTRYPOINT ["/entrypoint.sh"]
`

/**
 * Which image this project needs, from the same stack detection the Tests
 * section shows. Unreadable folder → the small image: a wrong guess there costs
 * a "dotnet is not in the bypass container" message, not a broken session.
 */
export function imageFor(projectPath: string): {
  image: string
  dotnet: boolean
  browser: boolean
} {
  let dotnet = false
  let browser = false
  try {
    // Root plus one level, the same listing the Tests section detects from, so the
    // image and the suite availability can never disagree about this project.
    const entries = stackEntries(projectPath, (dir) => readdirSync(dir))
    dotnet = sandboxNeedsDotnet(detectStacks(entries))
    // Evidence-led: a Playwright or Karma config, an Angular workspace, or the
    // dependency declared in a manifest. Everything else gets no browser, which is
    // the common case and is stated before a run rather than discovered during one.
    browser = needsBrowser(entries, (entry) => {
      try {
        return readFileSync(join(projectPath, entry), 'utf8')
      } catch {
        return null
      }
    })
  } catch {
    // Unreadable folder: the smallest image. A wrong guess here costs a "not in the
    // bypass container" message, never a broken session.
  }
  const base = dotnet ? DOTNET_IMAGE : IMAGE
  return { image: browser ? base + BROWSER_SUFFIX : base, dotnet, browser }
}

/** What a bypass session for this project can run, from the very same detection
 *  that picks the image, so the two can never disagree. A project without browser
 *  test infrastructure gets no browser here AND no browser in its container. */
export function sandboxToolsFor(projectPath: string): readonly SuiteTool[] {
  const { dotnet, browser } = imageFor(projectPath)
  return sandboxTools(dotnet, browser)
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
  const { image, dotnet, browser } = imageFor(projectPath)
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
      timeout: dotnet ? 2_400_000 : browser ? 1_200_000 : 600_000,
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
    build.stdin.end(dotnet ? dotnetDockerfile(browser) : dockerfile(browser))
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
  const { image, dotnet, browser } = imageFor(config.projectPath)
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
        // Chromium is immutable per version, so one volume serves every project, the
        // same reasoning as the NuGet cache above. Not mounted at all for a project
        // with no browser tests, which is most of them.
        ...(browser ? ['-v', `${BROWSER_VOLUME}:${BROWSER_CACHE_PATH}`] : []),
        ...refs.flatMap((r) => ['-v', `${r.host}:${r.container}:ro`]),
        '-w',
        '/workspace',
        // The image already runs as the unprivileged `node` user, so dropping
        // every capability and barring privilege escalation costs nothing
        // functionally while shrinking what a container-escape bug could reach.
        // Deliberately NOT --network none: the CLI needs outbound HTTPS to reach
        // the Anthropic API, which is the whole point of the session.
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        // A runaway build inside the sandbox should not exhaust the host's
        // process table. Generous enough for a .NET restore plus a test run.
        '--pids-limit',
        '1024',
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
