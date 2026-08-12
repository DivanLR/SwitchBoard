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
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
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
/**
 * The container's own node_modules, shadowing the host's.
 *
 * Required, not an optimisation: a Windows-installed tree holds Windows
 * binaries (e.g. `@rollup/rollup-win32-x64-*`, no Linux build), so `vitest`
 * inside the container dies on a missing Linux module — confirmed by running
 * it. `npm install` from inside the container is not the fix either:
 * /workspace is mounted read-write, so it would overwrite the host's own
 * node_modules with Linux binaries. Mounting a volume over that one
 * subdirectory keeps the two separate, the same trick the NuGet and Playwright
 * caches above already use.
 *
 * Per SESSION, for the same reason the home volume above is, and it arrived at
 * that the hard way: this started per project, so that a tree was not rebuilt
 * every session start. But `npm ci` deletes node_modules before it reinstalls,
 * the prompt in session-shaping.ts tells a container it is safe to run one, and
 * background work (verify, API, diagrams) is containerised for every project
 * now. Two containers of one project therefore delete and rebuild one directory
 * underneath each other, and the wreckage persists in the volume for every
 * later session. Worse than the transcript collision that moved the home
 * volume: a half-written native binary fails later, somewhere else, as a
 * missing or invalid module, and the obvious next suspect is the project's own
 * lockfile — which lives on the real bind mount, and is the developer's file.
 *
 * The cost is a cold tree per session, which NPM_CACHE_VOLUME below is there to
 * blunt.
 */
const NODE_MODULES_VOLUME_PREFIX = 'switchboard-node-modules-'
/**
 * npm's own download cache, shared across every project and session.
 *
 * Only here because node_modules went per session: without it each new session
 * re-downloads a whole dependency tree over the network rather than relinking a
 * warm cache. Safe to share where node_modules is not, because this cache is
 * content-addressed and npm writes into it atomically, whereas node_modules is
 * a mutable tree two installs race to delete.
 */
const NPM_CACHE_VOLUME = 'switchboard-npm-cache'
// Per SESSION, not per project: the container's cwd is always /workspace, and the
// CLI derives its storage key from cwd alone — so a volume shared by every
// concurrent session of one project put them all in the SAME
// `projects/-workspace` directory, confirmed to let them read (and corrupt) each
// other's transcripts. Sessions-per-project has no cap and sections also run
// containerised now, so that collision is reachable, not theoretical. Keying the
// volume to the session itself means no two running sessions ever open the same
// one. A resuming session is the one deliberate exception — see homeVolumeFor.
// ponytail: volumes now accumulate one per session forever (Docker never prunes
// them on its own). Fine at today's usage; add a sweep keyed off `endedAt` once
// disk use actually shows it.
const HOME_VOLUME_PREFIX = 'switchboard-claude-home-'

/**
 * Which Docker volume backs a containerised session's CLI home (~/.claude).
 *
 * Defaults to a volume keyed to the session's own id, so it can never collide
 * with a sibling session's — see HOME_VOLUME_PREFIX for why that matters now.
 *
 * A resuming session is the exception: its conversation was written into the
 * ANCESTOR session's volume (its own volume does not exist yet — this is its
 * first run), so it has to open that one to find it. `resumeFromSessionId` is
 * the ancestor's Switchboard session id; the caller already looks up that row
 * to resolve `resumeSdkSessionId` and can pass its `id` here too.
 *
 * Residual gap, not closed here: two DIFFERENT new sessions both resuming the
 * same already-ended ancestor at the same time would still collide on that
 * ancestor's volume. Narrower than the bug this fixes (it needs two resumes of
 * one specific ended session racing each other) and unchanged from today's
 * behaviour, so left as-is rather than adding machinery for it speculatively.
 */
export function homeVolumeFor(sessionId: string, resumeFromSessionId?: string): string {
  return `${HOME_VOLUME_PREFIX}${safeName(resumeFromSessionId ?? sessionId)}`
}

/** Docker volume/container names must be [a-zA-Z0-9_.-]. */
function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '')
}

/**
 * The most memory one bypass container may take, and the reason sessions
 * stopped dying in pairs.
 *
 * Docker Desktop runs every container in ONE shared WSL virtual machine with a
 * fixed allowance. Without a limit, one greedy run (a .NET restore, a test
 * pass, a browser) can exhaust it, and the kernel then kills whichever
 * container it likes — often someone else's session, with exit 137 and no
 * stderr, read as a code bug that never was (see explainExit). A cap decides
 * WHO pays when memory runs out: the greedy run stops, the VM and every other
 * session keep going — the same reasoning as --pids-limit below.
 *
 * 6 GiB because `dotnet restore` + `dotnet test` on a real solution fits
 * comfortably inside it while leaving room in a default 8–16 GiB allowance for
 * a second session; Docker also permits swap up to the same figure again, so a
 * brief spike slows down rather than gets killed.
 *
 * The knob is Settings → Sandbox memory (e.g. "12g", or "0" to remove the
 * cap) — an env var is nowhere a desktop-app user can reach.
 * SWITCHBOARD_SANDBOX_MEMORY still wins when set, for pre-Settings setups.
 */
export function sandboxMemoryArg(setting?: string): string[] {
  const value = process.env.SWITCHBOARD_SANDBOX_MEMORY?.trim() || setting?.trim() || '6g'
  return value === '0' ? [] : ['--memory', value]
}

// Built via stdin (`docker build -`): no build context, nothing to package.
// ponytail: the CLI version is whatever npm had at image-build time; to pick
// up a newer CLI, `docker rmi switchboard-sandbox` and the next bypass session
// rebuilds.
//
// Images are picked per project from what it actually needs: node always, the
// .NET SDK when stack detection says .NET, and browser libraries when the
// project has real browser test infrastructure (needsBrowser() in
// shared/test-catalog.ts) — four possible images, each built on first use.
//
// Browser libraries are absent by default (most projects never drive one; see
// BROWSER_SUFFIX). sandboxToolsFor() reads the same detection, so the Tests
// section says "browser is not in the bypass container" up front rather than
// failing a run afterwards.
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
// MSBUILDDISABLENODEREUSE / UseSharedCompilation: MSBuild worker nodes and the
// VBCSCompiler server deliberately linger after a build to speed up the next one.
// On a host they idle out in ~15 minutes; in this container they live for the
// whole session, stacking 1–2 GiB of cache on top of every real peak inside a
// hard --memory cap. Rebuilds get a few seconds slower per project; sessions stop
// dying at the cap. That trade is the point.
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
ENV MSBUILDDISABLENODEREUSE=1
ENV UseSharedCompilation=false
${browserEnv(browser)}WORKDIR /workspace
ENTRYPOINT ["/entrypoint.sh"]
`

/**
 * Which image this project needs, from the same stack detection the Tests
 * section shows. Unreadable folder → the small image: a wrong guess there costs
 * a "dotnet is not in the bypass container" message, not a broken session.
 */
function imageFor(projectPath: string): {
  image: string
  dotnet: boolean
  browser: boolean
  /** Has a package.json, so it needs a container-private node_modules. */
  node: boolean
} {
  let dotnet = false
  let browser = false
  const node = existsSync(join(projectPath, 'package.json'))
  try {
    // Root plus one level, the same listing the Tests section detects from, so the
    // image and the suite availability can never disagree about this project.
    const entries = stackEntries(projectPath, (dir) => readdirSync(dir))
    dotnet = sandboxNeedsDotnet(detectStacks(entries))
    // Evidence-led: a Playwright or Karma config, an Angular workspace, or a
    // manifest dependency. Everything else gets no browser (the common case).
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
  return { image: browser ? base + BROWSER_SUFFIX : base, dotnet, browser, node }
}

/** What a bypass session for this project can run, from the very same detection
 *  that picks the image, so the two can never disagree. A project without browser
 *  test infrastructure gets no browser here AND no browser in its container. */
export function sandboxToolsFor(projectPath: string): readonly SuiteTool[] {
  const { dotnet, browser } = imageFor(projectPath)
  return sandboxTools(dotnet, browser)
}

/**
 * Why git will not work at /workspace, or null when it will.
 *
 * The container mounts ONLY the project folder, so git works there exactly when
 * a real .git directory sits at the project root. Every other shape reads to the
 * agent as "the history was deleted", and it reports exactly that mid-task. The
 * notice states the truth up front instead — same rule as "browser is not in the
 * bypass container". Unreadable folder → null: a wrong warning is worse than none.
 */
export function gitNotice(projectPath: string): string | null {
  try {
    const dotGit = join(projectPath, '.git')
    if (existsSync(dotGit)) {
      if (statSync(dotGit).isDirectory()) return null
      // A .git FILE is a worktree/submodule checkout: its gitdir points at the
      // real repository, which is a host path outside the mount.
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
/** Whether this project's container gets its own node_modules volume, so the
 *  session can be told (see sandboxSystemPromptAppend). Same detection the mount
 *  itself uses, so the prompt and the reality cannot disagree. */
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
  projectPath: string
  refDirs: string[]
  /** Settings → Sandbox memory; the env var still wins (see sandboxMemoryArg). */
  sandboxMemory?: string
  /** Switchboard id of the ended session this one resumes, when its transcript
   *  still lives only in THAT session's own home volume (see homeVolumeFor).
   *  `undefined` for a fresh session.
   *
   *  Required rather than optional, and deliberately so: this field was optional
   *  when it was introduced, the single call site quietly omitted it, and every
   *  containerised resume silently opened an empty volume while the SDK was told
   *  to resume a transcript that lived in another one. An optional field cannot
   *  be forgotten if the compiler will not let it be. */
  resumeFromSessionId: string | undefined
}): SandboxPlan {
  const refs = refMounts(config.refDirs)
  const containerName = `${NAME_PREFIX}${safeName(config.sessionId)}`
  const homeVolume = homeVolumeFor(config.sessionId, config.resumeFromSessionId)
  const { image, dotnet, browser, node } = imageFor(config.projectPath)
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
        // Mounted OVER the project's own node_modules (see
        // NODE_MODULES_VOLUME_PREFIX): the container must never touch the host's.
        ...(node
          ? [
              '-v',
              `${NODE_MODULES_VOLUME_PREFIX}${safeName(config.sessionId)}:/workspace/node_modules`,
              '-v',
              `${NPM_CACHE_VOLUME}:/home/node/.npm`,
            ]
          : []),
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
        // The same argument for memory: one session's appetite must not take the
        // shared virtual machine down with it (see sandboxMemoryArg). '0' removes
        // the cap, which is what a developer setting it to 0 is asking for.
        ...sandboxMemoryArg(config.sandboxMemory),
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
