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
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { cpus, homedir } from 'node:os'
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
// Superseded: this used to say volumes accumulate one per session forever,
// fine at today's usage, add a sweep keyed off `endedAt` once disk use actually
// shows it. Disk was not the reason that stopped being true — the entrypoint
// copies the host's OAuth credentials into EVERY one of these volumes
// (SHARED_SETUP), so an unbounded set of them is an unbounded set of places a
// copy of the developer's login sits on disk. sweepStaleVolumes below removes
// one 7 days after its session ended (never a live one — see homeVolumeFor for
// why a volume cannot simply be deleted at session end instead: a RESUMING
// session still has to open its ancestor's).
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
 * comfortably inside it while leaving room for a second session.
 *
 * `--memory-swap` is pinned to the SAME figure, which is what makes the cap a
 * cap. Passing `--memory` alone lets Docker allow swap up to the same figure
 * again, so a "12g" container could reach ~24 GiB — larger than the whole WSL
 * VM on a 32 GB machine, at which point the VM's own kernel kills whichever
 * container it likes and the containment promised above never happens. The
 * cushion that doubling bought was worth less than the containment it cost: a
 * run that genuinely needs more now stops as itself, which is the entire point
 * of having a limit.
 *
 * The knob is Settings → Sandbox memory (e.g. "12g", or "0" to remove the
 * cap) — an env var is nowhere a desktop-app user can reach.
 * SWITCHBOARD_SANDBOX_MEMORY still wins when set, for pre-Settings setups.
 */
export function sandboxMemoryArg(setting?: string): string[] {
  const value = process.env.SWITCHBOARD_SANDBOX_MEMORY?.trim() || setting?.trim() || '6g'
  return value === '0' ? [] : ['--memory', value, '--memory-swap', value]
}

/**
 * How many cores one container may use: half the host's, floored at 2.
 *
 * Half rather than all, because MAX_CONTAINERS (session-manager.ts) lets two run
 * at once and the two numbers have to be derived from the same assumption or
 * they drift apart, which is exactly how the memory cap came to be sized for a
 * world with one container in it. Floored at 2 so a small host still runs a
 * build at all rather than serialising it into a timeout.
 */
export function cpuShare(): string {
  return String(Math.max(2, Math.floor(cpus().length / 2)))
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
  const name = browser ? base + BROWSER_SUFFIX : base
  return { image: `${name}:${recipeTag(dotnet, browser)}`, dotnet, browser, node }
}

/**
 * A tag derived from the Dockerfile that produces the image.
 *
 * `ensureSandboxImage` builds only when `docker image inspect` misses, which is
 * the right rule — a rebuild on every session start would be unusable. It was
 * paired with a FIXED tag, so once an image existed under that name it was never
 * built again no matter how the recipe changed. Editing the Dockerfile did
 * nothing on any machine that had already run one session.
 *
 * That is not hypothetical. The mutation suite runs `dotnet stryker`, the .NET
 * image gained a `dotnet tool install --global dotnet-stryker` line to support
 * it, and machines built before that line kept running the old image: every
 * mutation run came back "Could not execute because the specified command or
 * file was not found", which reads as the developer's project being broken.
 *
 * Content-addressed, so a changed recipe is a different tag, misses the inspect,
 * and builds — reusing Docker's layer cache for everything that did not change.
 * The old image is left behind rather than removed: it may still back a running
 * container, and reclaiming disk is `docker image prune`'s job, not a session
 * start's.
 */
export function recipeTag(dotnet: boolean, browser: boolean): string {
  const recipe = dotnet ? dotnetDockerfile(browser) : dockerfile(browser)
  return createHash('sha256').update(recipe).digest('hex').slice(0, 12)
}

/** What a bypass session for this project can run, from the very same detection
 *  that picks the image, so the two can never disagree. A project without browser
 *  test infrastructure gets no browser here AND no browser in its container. */
/** The image a project's bypass session runs in, tag and all. Exported for the
 *  test that proves a changed recipe is a changed tag. */
export function sandboxImageFor(projectPath: string): string {
  return imageFor(projectPath).image
}

export function sandboxToolsFor(projectPath: string): readonly SuiteTool[] {
  const { dotnet, browser } = imageFor(projectPath)
  return sandboxTools(dotnet, browser)
}

/** How long a gitRoot/gitNotice answer is trusted before it is re-read. */
const GIT_CACHE_TTL_MS = 30_000

/**
 * Memoise a path-keyed synchronous read for GIT_CACHE_TTL_MS.
 *
 * handlers.ts's projectList() calls gitNotice for EVERY project on EVERY
 * `projects.list` invoke — and a session start, an archive, a rename and a
 * section dispatch all trigger one of those refreshes — and gitNotice is
 * existsSync + statSync + a parent-directory walk + readdirSync, synchronously,
 * on the main thread (gitRoot is the same shape, minus the statSync). That is
 * the storm this collapses.
 *
 * A TTL, not a permanent cache: a permanent one needs invalidation wired
 * through every place that could change the answer (git init, a repo cloned
 * into a project folder, a worktree turned into a plain checkout), and there
 * is no single choke point for all of those to invalidate through. A short TTL
 * needs none of that plumbing and still collapses the same-tick storm above —
 * the trade is a stale answer for up to 30s after one of those events, made on
 * purpose here rather than left as an accident of no caching at all.
 */
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

/**
 * Why git will not work at /workspace, or null when it will.
 *
 * The container mounts ONLY the project folder, so git works there exactly when
 * a real .git directory sits at the project root. Every other shape reads to the
 * agent as "the history was deleted", and it reports exactly that mid-task. The
 * notice states the truth up front instead — same rule as "browser is not in the
 * bypass container". Unreadable folder → null: a wrong warning is worse than none.
 */
/**
 * The directory git commands should actually run in for a project.
 *
 * The project root when it is a repository, and otherwise the single
 * sub-directory that is one. That second case is not exotic: a .NET repository
 * is routinely registered by its containing folder while the solution and the
 * .git live one level down, which is the same layout stackEntries already walks
 * for solution files. Detection coped with it and git did not, so the Tests
 * section found seven suites for a project whose Diff tab said there was no
 * repository at all.
 *
 * Null when there is no repository at or just below the root. Deliberately only
 * ONE level: deeper would start guessing which of several nested repositories a
 * developer meant.
 */
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

// Both keep gitRootImpl/gitNoticeImpl's exact signature and return values —
// callers (session-manager.ts, handlers.ts, the test suites) see no difference
// except that a repeated call inside GIT_CACHE_TTL_MS is free.
export const gitRoot = memoizeGitRead(gitRootImpl)
export const gitNotice = memoizeGitRead(gitNoticeImpl)

function credsPath(): string {
  return join(homedir(), '.claude', '.credentials.json')
}

/**
 * In-flight image builds, keyed by the content-addressed tag (recipeTag), so
 * two sessions that both need an image nobody has built yet share ONE `docker
 * build` instead of racing two. session-manager.ts already solved the same
 * shape of problem for probeAvailableModels (see its `probingModels` field) —
 * this is that pattern again, at module scope because docker-sandbox.ts has no
 * instance to hang a field off. Cleared once the build settles, success or
 * failure alike: a failed build must not poison every later retry with a
 * promise that can only ever reject again.
 */
const buildingImages = new Map<string, Promise<void>>()

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
  // A second session that needs this SAME never-built image joins the build
  // already in flight rather than starting its own: without this, two sessions
  // on their very first run each spawned `docker build`, doubling the wait and
  // racing two builds against one tag.
  const existing = buildingImages.get(image)
  if (existing) {
    await existing
    return
  }
  const build = new Promise<void>((resolve, reject) => {
    const proc = spawn('docker', ['build', '-t', image, '-'], {
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe'],
      // The .NET SDK layer is ~1 GB to pull; 10 minutes is not enough on a slow
      // link, and timing out here strands the developer with a half-built image.
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
    proc.stdin.end(dotnet ? dotnetDockerfile(browser) : dockerfile(browser))
  })
  buildingImages.set(image, build)
  try {
    await build
  } finally {
    // Only the caller that created the entry clears it, once it settles either
    // way — a later caller sharing `build` via the `existing` branch above never
    // reaches this finally, so there is no race over who deletes it.
    buildingImages.delete(image)
  }
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

/**
 * One ended session's own node_modules volume — the large one, and the one
 * nothing ever reads again once this session is gone (see
 * NODE_MODULES_VOLUME_PREFIX: it exists only to shadow the host's tree for the
 * lifetime of ONE container). Unlike the home volume, no later session can
 * legitimately want this one back, so it is removed at session end rather than
 * left for the 7-day sweep below — the sweep is the backstop for the volume
 * that CANNOT be removed this eagerly, not the primary path for this one.
 *
 * Fire-and-forget and silent on failure: a volume still attached to a
 * container that has not fully torn down yet simply fails to remove, and
 * sweepStaleVolumes catches it on the next app launch.
 */
export function removeNodeModulesVolume(sessionId: string): void {
  execFile(
    'docker',
    ['volume', 'rm', `${NODE_MODULES_VOLUME_PREFIX}${safeName(sessionId)}`],
    { windowsHide: true },
    () => {},
  )
}

/** How long an ended session's home/node_modules volumes may sit before
 *  sweepStaleVolumes removes them — see HOME_VOLUME_PREFIX for what this
 *  bounds (an accumulating set of copies of the developer's OAuth login) and
 *  why 7 days: long enough that "I'll resume that later today" still works
 *  (a resuming session bridges into its ANCESTOR's home volume — see
 *  homeVolumeFor — so removing it too soon breaks a used feature), short
 *  enough that the credentials copy and the disk it sits on are both bounded
 *  rather than growing forever. */
const STALE_VOLUME_AGE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Startup sweep: remove home and node_modules volumes for sessions old enough
 * — or gone from the sessions table entirely — that nothing can still want
 * them.
 *
 * Age comes from the sessions TABLE (via `sessionById`), not from Docker's own
 * volume metadata: a volume carries no timestamp Docker itself keeps current
 * with "when did the session that owns this end", so the app's own record is
 * the only source that can answer that. Three answers `sessionById` can give,
 * each handled differently:
 *   - no row at all (`undefined`) — stale immediately. Nothing remembers
 *     starting this session, so nothing can be waiting to resume it either.
 *   - a row with `endedAt: null` — NEVER removed. This is a live session (or
 *     one this app still believes is live), and removing HOME_VOLUME_PREFIX's
 *     volume out from under a running container is a worse bug than the one
 *     this sweep exists to fix.
 *   - a row with `endedAt` older than STALE_VOLUME_AGE_MS — removed.
 *
 * Listed with a plain `docker volume ls -q` rather than a `--filter name=`
 * regex (the way sweepOrphanedContainers filters containers): the shared
 * caches (NUGET_VOLUME, NPM_CACHE_VOLUME, BROWSER_VOLUME) are NOT session-keyed
 * and must never be swept, and matching them out by two exact prefixes
 * client-side is simpler to get right than trusting a server-side filter to
 * anchor the same way for volumes as it does for containers.
 *
 * Fire-and-forget and silent on failure, the same as sweepOrphanedContainers:
 * a best-effort startup tidy, never something a session start should wait on.
 */
export function sweepStaleVolumes(
  sessionById: (sessionId: string) => { endedAt: string | null } | undefined,
): void {
  execFile('docker', ['volume', 'ls', '-q'], { windowsHide: true }, (error, stdout) => {
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
      if (session.endedAt === null) continue // still live — never touched
      if (Date.now() - Date.parse(session.endedAt) > STALE_VOLUME_AGE_MS) stale.push(name)
    }
    if (stale.length > 0) execFile('docker', ['volume', 'rm', ...stale], { windowsHide: true }, () => {})
  })
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
  /**
   * The docker CLIENT's own stderr tail from the most recent spawn (empty
   * string until spawn() has actually run). A hard `docker run` failure — a
   * bad mount, a name conflict, an invalid --memory value — dies before
   * anything inside the container ever starts, so the SDK never sees a
   * message shaped for explainExit to read; this is the only trace left of
   * WHY, and it used to only ever reach console.error (see spawn's own drain
   * comment below) rather than the developer. session.ts's run() reads it
   * here to append to a fatal exit's detail.
   */
  lastStderr: () => string
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
  // Declared here, not inside `spawn`, so it survives past one call and
  // `lastStderr()` can still answer once the docker process has already
  // exited — session.ts's run() reads it from its catch block, after the
  // container is gone.
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
        // Half the host's cores, because a container without one sees ALL of
        // them and every test runner sizes itself from that count. Playwright
        // and vitest both default their worker count to the reported CPUs, so
        // two containers each launched twelve workers on a twelve-core host and
        // twenty-four browsers' worth of memory arrived at once. Sharing the
        // cores is the honest description of what is actually happening.
        '--cpus',
        cpuShare(),
        // Chromium writes shared memory here, and Docker's 64 MB default is a
        // well-known cause of renderer crashes under load. Only for a project
        // that actually drives a browser; it is carved out of the memory cap
        // above rather than added to it, so it is not free.
        ...(browser ? ['--shm-size', '512m'] : []),
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
      // a failed `docker run` (mount denied, name conflict) isn't silent — it used
      // to only ever reach console.error below; now lastStderr() on the SandboxPlan
      // (declared above, outside this closure) lets session.ts surface it too.
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
