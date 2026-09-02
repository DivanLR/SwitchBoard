// Typed IPC endpoint implementations (contracts/ipc-contract.md). One generic
// invoke channel carries every method with a WireResult envelope so stable
// error codes survive Electron's error serialisation. Push channels batch
// stream events at >= 30 Hz flushes (SC-007).
import { clipboard, dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import type { Session, SessionEvent } from '@shared/domain'
import type { SectionKind } from '@shared/domain'
import { canPassEval, isDangerousCommand, sessionName } from '@shared/domain'
import {
  DIAGRAM_FILE_PICKS,
  DIAGRAM_PLUGIN,
  DIAGRAMS_DIR,
  archifyPrompt,
  diagramFileName,
  diagramPrompt,
  isDiagramFilePick,
} from '@shared/diagram'
import { CLEANUP_GROUPS } from '@shared/command-catalog'
import { applyToRegionPrompt } from '@shared/diff-apply'
import type {
  Counters,
  InvokeMap,
  InvokeMethod,
  IpcError,
  ProjectListItem,
  PushChannel,
  PushMap,
  RulesView,
  WireResult,
} from '@shared/ipc-types'
import { INVOKE_CHANNEL, isIpcError, isIpcErrorCode } from '@shared/ipc-types'
import { rulesView } from '@main/inbox/rule-prefs'
import type { Repositories } from '@main/store/repositories'
import type { SessionManager } from '@main/sessions/session-manager'
import { installPlugin } from '@main/sessions/plugin-install'
import type { PermissionBroker } from '@main/inbox/permission-broker'
import {
  addProjectRef,
  registerProject,
  removeProjectRef,
  repointProject,
  suggestProjects,
} from '@main/projects/discovery'
// existsSync/readdirSync survive here only for 'diagrams.generate' (unaffected
// by this pass — it names a NEW file rather than statting an existing one, so
// it never carried the per-file stat fan-out the audit flagged). Every other
// caller that used to reach into 'node:fs' synchronously now reads through
// 'node:fs/promises' below, off the main thread.
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { detectStacks, stackById, stackEntries } from '@shared/test-catalog'
import { attemptsPrompt, checkPrompt, judgePrompt } from '@main/evals/eval-dispatch'
import { evidencePrompt, planSuites, verifyPrompt } from '@main/evals/verify-dispatch'
import { apiDataPrompt } from '@main/evals/api-dispatch'
import { resolveApiHost, scanProjectEndpoints } from '@main/evals/api-scan'
import { recentEndpoints } from '@shared/api-endpoints'
import { apiReportFileName, apiReportMarkdown } from '@shared/api-report'
import { gitNotice, sandboxToolsFor } from '@main/sessions/wslc-sandbox'
import { comboDocPath, readComboDoc, readSchemaDoc } from '@main/mcp/schema-doc'
import { comboKey } from '@shared/mcp-combo'
import { installSpecKit, readSpecDetail, readSpecKitState } from '@main/specs/spec-kit'
import { readDiffList, readFileDiff } from '@main/sessions/session-manager'
import { readDiagramList } from '@main/diagrams/list'
import { importSkills } from '@main/skills/import'
import { disableSkill, enableSkill, removeSkill } from '@main/skills/install'
import { check as checkForUpdates, installNow } from '@main/updater'

const EVENT_FLUSH_INTERVAL_MS = 33 // >= 30 Hz (contract)
const COUNTER_DEBOUNCE_MS = 50

/** A pattern the engines can actually use; they treat an invalid one as no match. */
function isValidRegExp(pattern: string): boolean {
  try {
    new RegExp(pattern)
    return true
  } catch {
    return false
  }
}

/** Owns every main -> renderer push channel, including event batching. */
export class RendererPush {
  private eventBuffer: SessionEvent[] = []
  private flushTimer: NodeJS.Timeout | null = null
  private counterTimer: NodeJS.Timeout | null = null

  constructor(
    private getWindow: () => BrowserWindow | null,
    private computeCounters: () => Counters,
  ) {}

  event(event: SessionEvent): void {
    this.eventBuffer.push(event)
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushEvents(), EVENT_FLUSH_INTERVAL_MS)
    }
  }

  flushEvents(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.eventBuffer.length === 0) return
    // Self-healing rather than a dispose() nobody calls: nothing tells this
    // class when `mainWindow` is destroyed, so a flushTimer already pending at
    // that moment used to fire anyway and hand its batch to `send`, which
    // no-ops silently. Checked here instead so the batch is dropped
    // explicitly, and — the actual bug — so a background session that keeps
    // producing events after the window is gone (a verify or API-eval run in
    // its own container does not stop just because the window closed) is not
    // left quietly rearming a fresh 33ms timer forever with nowhere to deliver.
    const window = this.getWindow()
    if (!window || window.isDestroyed()) {
      this.eventBuffer = []
      return
    }
    const batch = this.eventBuffer.splice(0)
    this.send('push.event', batch)
  }

  countersChanged(): void {
    if (this.counterTimer) return
    this.counterTimer = setTimeout(() => {
      this.counterTimer = null
      // Same self-healing check as flushEvents: skip computeCounters() (a real
      // query) entirely once there is no window left to show it to, rather
      // than computing an answer only for `send` to throw away.
      const window = this.getWindow()
      if (!window || window.isDestroyed()) return
      this.send('push.counters', this.computeCounters())
    }, COUNTER_DEBOUNCE_MS)
  }

  /** Typed pass-through for every other push channel. */
  push<C extends PushChannel>(channel: C, payload: PushMap[C]): void {
    this.send(channel, payload)
  }

  private send(channel: string, payload: unknown): void {
    const window = this.getWindow()
    if (!window || window.isDestroyed()) return
    window.webContents.send(channel, payload)
  }
}

interface HandlerDeps {
  repos: Repositories
  manager: SessionManager
  /** Where imported skills are staged (see main/skills/install.ts). Passed in
   *  rather than derived here so the handlers stay free of Electron's `app`. */
  skillsStagingRoot: string
  broker: PermissionBroker
  /** The trusted main window; IPC is accepted only from its webContents (A17). */
  getWindow: () => BrowserWindow | null
  /** Reserved project id backing the global Database MCP session; marked
   *  `reserved` in projectList so the sidebar never lists it as a real project. */
  dbProjectId: string
}

function localMidnightIso(): string {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
}

export function computeCounters(repos: Repositories): Counters {
  const live = repos.sessions.listUnended()
  const midnight = localMidnightIso()
  return {
    running: live.filter((s) => s.status === 'working').length,
    needsYou: live.filter((s) => s.status === 'needs_you').length,
    costTodayUsd: repos.events.costSince(midnight),
    tokensToday: repos.events.tokensSince(midnight),
  }
}

type Handlers = {
  [M in InvokeMethod]: (req: InvokeMap[M]['req']) => InvokeMap[M]['res'] | Promise<InvokeMap[M]['res']>
}

function toIpcError(error: unknown): IpcError {
  if (isIpcError(error)) {
    // Normalise rather than cast. This used to be `error.code as IpcError['code']`,
    // which asserted away the one thing that could not be known: isIpcError checks
    // only that `code` is a string, so a typo here or a throw from a module that
    // never imported IpcError reached the renderer as an unrecognised code, fell
    // through every branch of its switch, and surfaced as nothing at all.
    return {
      code: isIpcErrorCode(error.code) ? error.code : 'INTERNAL',
      message: error.message,
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { code: 'INTERNAL', message }
}

/**
 * A diagram's absolute path, or a refusal.
 *
 * `file` crosses from the renderer, so it is checked twice: rejected outright if
 * it carries a separator or a parent segment, then resolved and required to sit
 * inside the project's own diagrams folder. Shared by open and read so the two
 * cannot drift apart — a guard that only one caller uses is a guard waiting to
 * be forgotten by the second.
 */
function diagramPath(repos: Repositories, projectId: string, file: string): string {
  const project = repos.projects.byId(projectId)
  if (!project) throw { code: 'NOT_FOUND', message: 'Project not found' } satisfies IpcError
  if (file.includes('/') || file.includes('\\') || file.includes('..')) {
    throw { code: 'INVALID_PATH', message: 'Not a diagram file name' } satisfies IpcError
  }
  const dir = resolve(project.path, DIAGRAMS_DIR)
  const target = resolve(dir, file)
  if (target !== dir && !target.startsWith(dir + sep)) {
    throw { code: 'INVALID_PATH', message: 'That file is outside the diagrams folder' } satisfies IpcError
  }
  return target
}

/**
 * Pre-fetches exactly the directory listings `stackEntries` (test-catalog.ts)
 * would ask its synchronous `(dir) => string[]` reader for: the project root,
 * plus each immediate child stackEntries itself descends into.
 *
 * stackEntries keeps its own walk (the SKIP set, the dot-prefix rule) private,
 * and its signature is pinned — test-catalog.spec.ts asserts it takes a plain
 * synchronous reader, because it is shared with the sandbox-image decision,
 * which has no async budget of its own. So the directory reads have to happen
 * BEFORE stackEntries runs, into a plain Map, with a synchronous closure handed
 * to stackEntries that only ever looks an already-fetched answer up. The SKIP
 * set is duplicated rather than imported for the same reason: it is not
 * exported, and importing a private implementation detail would be a more
 * fragile coupling than a short literal that only has to agree with a walk
 * this file already reads in full above.
 *
 * If the two walks ever drift, a directory this prefetch missed reads back as
 * `undefined` and the closure below throws — which stackEntries' own try/catch
 * already treats as "not a directory", the same outcome a real ENOTDIR gets.
 * Drift here degrades gracefully; it does not crash the handler.
 */
async function preReadStackEntries(root: string): Promise<Map<string, string[]>> {
  const SKIP = new Set(['node_modules', '.git', 'bin', 'obj', 'dist', 'out', 'release', '.vs'])
  const listing = new Map<string, string[]>()
  const top = await readdir(root)
  listing.set(root, top)
  await Promise.all(
    top
      .filter((name) => !SKIP.has(name.toLowerCase()) && !name.startsWith('.'))
      .map(async (name) => {
        try {
          listing.set(`${root}/${name}`, await readdir(join(root, name)))
        } catch {
          // Not a directory, or unreadable — stackEntries' own catch handles
          // this the same way when its (dir) => string[] reader throws.
        }
      }),
  )
  return listing
}

/**
 * Every {marketplace, pkg} pair 'plugins.install' may actually hand to the CLI.
 *
 * `req.marketplace`/`req.pkg` cross straight from the renderer into
 * `installPlugin` (plugin-install.ts), which clones a remote repo and installs
 * whatever it finds at USER scope with no validation of its own — by design,
 * since it is meant to run exactly the strings it is given. Every real caller
 * offers one of the plugins already catalogued for the Cleanup section
 * (CLEANUP_GROUPS) or the diagram skill (DIAGRAM_PLUGIN), so a request naming
 * anything else did not come from this app's own UI, and is refused here
 * before the CLI ever runs rather than trusted as far as a child process.
 */
const ALLOWED_PLUGINS: ReadonlySet<string> = new Set([
  ...CLEANUP_GROUPS.map((group) => `${group.marketplace}|${group.pkg}`),
  `${DIAGRAM_PLUGIN.marketplace}|${DIAGRAM_PLUGIN.pkg}`,
])

export function registerIpcHandlers(deps: HandlerDeps): void {
  const { repos, manager, broker, dbProjectId, skillsStagingRoot } = deps

  const projectList = (): ProjectListItem[] =>
    repos.projects.listActive().map((project) => {
      // Live rows come from the manager rather than the database because only it
      // holds the in-flight status; liveSessionIds is insertion-ordered, which is
      // start order. A project running nothing falls back to its most recent ended
      // session, which is exactly what the sidebar showed when a project could only
      // ever have one.
      const live = manager
        .liveSessionIds()
        .map((id) => manager.liveSessionRow(id))
        .filter((s): s is Session => !!s && s.projectId === project.id)
      const latest = live.length === 0 ? repos.sessions.latestForProject(project.id) : undefined
      const rows = live.length > 0 ? live : latest ? [latest] : []
      // Named from the work each was started for, so a project running three
      // sessions does not show the same branch three times with nothing to tell
      // them apart. Read once per project rather than per session.
      const work = {
        verifyRunSessionIds: repos.verifyRuns
          .listForProject(project.id)
          .map((r) => r.sessionId)
          .filter((id): id is string => !!id),
        apiRunSessionIds: repos.apiRuns
          .listForProject(project.id)
          .map((r) => r.sessionId)
          .filter((id): id is string => !!id),
        diagrams: [...repos.diagramRequests.forProject(project.id).values()],
        // Live kinds from the manager, overlaid on what each row persisted, so an
        // ENDED section session still knows what it was opened for (migration 028).
        suites: manager.isolatedSuiteNamesFor(project.id),
        kinds: {
          ...Object.fromEntries(
            rows.filter((s) => s.sectionKind).map((s) => [s.id, s.sectionKind as SectionKind]),
          ),
          ...manager.sectionKinds(project.id),
        },
      }
      // A typed name wins over the derived one: `label` is a fact only the
      // developer knows, and nothing the app works out may overwrite it.
      const sessions = rows.map((s) => ({
        ...s,
        name: s.label ?? sessionName(s.id, work, s.branch, s.endReason),
      }))
      return {
        ...project,
        session: sessions[0] ?? null,
        sessions,
        gitNotice: gitNotice(project.path),
        drafts: repos.drafts.listForProject(project.id),
        reserved: project.id === dbProjectId,
      }
    })

  /**
   * Puts a rule change into force, then reports the new list.
   *
   * The reload is the point: the broker and the noise classifier both read a
   * cached set, so without it an edit would only take effect on the next launch.
   */
  const applyRules = (): RulesView => {
    broker.rules.reload()
    return rulesView(repos.rulePrefs.list())
  }

  const handlers: Handlers = {
    'projects.list': () => ({ projects: projectList(), counters: computeCounters(repos) }),
    // Modal on the main window, so it cannot be lost behind it. Cancelling
    // returns null rather than throwing: the developer changed their mind, which
    // the caller handles by leaving the folder field alone.
    'dialog.pickFolder': async () => {
      const opts = { title: 'Choose a project folder', properties: ['openDirectory' as const] }
      const parent = deps.getWindow()
      // Unparented overload is the fallback if the window is gone.
      const picked = parent
        ? await dialog.showOpenDialog(parent, opts)
        : await dialog.showOpenDialog(opts)
      const path = picked.canceled ? undefined : picked.filePaths[0]
      return { path: path ?? null }
    },
    // Same shape as pickFolder, and cancelling is the same ordinary outcome. The
    // command names the filters rather than the renderer supplying them, so the
    // set of dialogues this can open is closed and reviewable in one table.
    'dialog.pickFile': async (req) => {
      if (!isDiagramFilePick(req.command)) {
        throw {
          code: 'INVALID_PATH',
          message: `No file picker for ${req.command}`,
        } satisfies IpcError
      }
      const pick = DIAGRAM_FILE_PICKS[req.command]
      const opts = {
        title: pick.title,
        properties: ['openFile' as const],
        filters: [
          { name: pick.name, extensions: [...pick.extensions] },
          { name: 'All files', extensions: ['*'] },
        ],
      }
      const parent = deps.getWindow()
      const picked = parent
        ? await dialog.showOpenDialog(parent, opts)
        : await dialog.showOpenDialog(opts)
      const path = picked.canceled ? undefined : picked.filePaths[0]
      return { path: path ?? null }
    },
    'projects.register': async (req) => {
      const suggested = (await suggestProjects(repos)).some(
        (s) => s.path.toLowerCase() === req.path.toLowerCase(),
      )
      return registerProject(repos, {
        path: req.path,
        name: req.name,
        source: suggested ? 'suggested' : 'manual',
        defaultSessionMode: req.defaultSessionMode,
      })
    },
    'projects.setSessionMode': (req) => {
      if (!repos.projects.byId(req.projectId)) {
        throw { code: 'NOT_FOUND', message: 'Project not found' } satisfies IpcError
      }
      repos.projects.setSessionMode(req.projectId, req.mode)
    },
    'projects.rename': (req) => {
      if (!repos.projects.byId(req.projectId)) {
        throw { code: 'NOT_FOUND', message: 'Project not found' } satisfies IpcError
      }
      const name = req.name.trim()
      if (name.length === 0) {
        throw { code: 'INVALID_PATH', message: 'Name cannot be empty' } satisfies IpcError
      }
      repos.projects.rename(req.projectId, name)
    },
    'projects.repoint': (req) => repointProject(repos, req.projectId, req.path),
    'projects.move': (req) => {
      repos.projects.move(req.projectId, req.toIndex)
    },
    'projects.refs.add': (req) => addProjectRef(repos, req.projectId, req.target),
    'projects.refs.remove': (req) => removeProjectRef(repos, req.projectId, req.path),
    'projects.archive': (req) => {
      const active = repos.sessions.activeForProject(req.projectId)
      if (active) {
        throw {
          code: 'ALREADY_ACTIVE',
          message: 'Stop the session before archiving the project',
        } satisfies IpcError
      }
      if (!repos.projects.byId(req.projectId)) {
        throw { code: 'NOT_FOUND', message: 'Project not found' } satisfies IpcError
      }
      repos.projects.archive(req.projectId)
    },
    // Read at spawn like the mode is, so a live session keeps whatever it
    // started in and this applies from the next one.
    'projects.setUseContainers': (req) => {
      if (!repos.projects.byId(req.projectId)) {
        throw { code: 'NOT_FOUND', message: 'Project not found' } satisfies IpcError
      }
      repos.projects.setUseContainers(req.projectId, req.on)
    },
    'sessions.rename': (req) => manager.renameSession(req.sessionId, req.label),
    'sessions.start': (req) =>
      // No mode default here: undefined has to reach the manager as "unspecified"
      // so it can fall back to the project's own choice.
      manager.startSession(req.projectId, req.resume ?? false, req.mode, req.carryTranscriptFrom, {
        containerised: req.containerised === true,
      }),
    // Text out only. There is deliberately no clipboard READ endpoint: that is
    // the direction that could lift whatever the developer last copied from
    // another application, and nothing in this app needs it.
    'clipboard.write': (req) => {
      clipboard.writeText(req.text)
    },
    'transcripts.save': (req) => manager.saveTranscript(req.sessionId),
    'transcripts.list': () => manager.listTranscripts(),
    'sessions.setPlanMode': (req) => {
      manager.setPlanMode(req.sessionId, req.enabled)
    },
    // The note is what stops this being indistinguishable afterwards from a
    // session that closed itself or died — see SessionManager.stopSession.
    'sessions.stop': (req) => manager.stopSession(req.sessionId, 'You ended this session.'),
    // Straight from the row, not from the sidebar's view of it: see the contract.
    'sessions.fate': (req) => {
      const session = repos.sessions.byId(req.sessionId)
      if (!session) return null
      return {
        endedAt: session.endedAt,
        endReason: session.endReason,
        statusDetail: session.statusDetail,
      }
    },
    'sessions.interrupt': (req) => manager.interruptSession(req.sessionId),
    'sessions.send': (req) => {
      const result = manager.sendMessage(req.sessionId, req.text, req.agentId)
      // Drafts offered in the composer are consumed by the first send (FR-019 edge case).
      const session = repos.sessions.byId(req.sessionId)
      if (session) {
        for (const draft of repos.drafts.listForProject(session.projectId)) {
          repos.drafts.delete(draft.id)
        }
      }
      return result
    },
    'sessions.answerQuestion': (req) => {
      broker.answerQuestion(req.sessionId, req.eventId, req.choice)
    },
    'sessions.editQueued': (req) => {
      manager.editQueuedSend(req.sessionId, req.eventId, req.text)
    },
    'sessions.events': (req) => repos.events.page(req.sessionId, req.beforeSeq, req.limit),
    'sessions.promptHistory': (req) => repos.commandHistory.recent(req.projectId, req.limit),
    'projects.commands': (req) => repos.projectCommands.get(req.projectId),
    'skills.list': () => repos.customSkills.list(),
    /*
     * Import, then switch on, then report the whole list back.
     *
     * The registry is written only AFTER the files are on disk, and each skill is
     * enabled one at a time with its row already inserted, so a failure half way
     * leaves rows that match the filesystem rather than a registry describing
     * skills that never landed. importSkills itself removes a half-written skill
     * directory before it throws.
     */
    'skills.import': async (req) => {
      const result = await importSkills(req.url, skillsStagingRoot, repos.customSkills.names())
      repos.customSkills.insertMany(result.imported)
      for (const skill of result.imported) {
        try {
          await enableSkill(skillsStagingRoot, skill.name)
        } catch {
          // The files are staged and the row exists; it simply is not live. The
          // switch in Settings is what fixes that, and it now has something to
          // switch. Failing the whole import over one copy would throw away the
          // other nine skills that did land.
          repos.customSkills.setEnabled(skill.name, false)
        }
      }
      // Live sessions re-read their skills, so one that is already open picks the
      // new command up without being restarted (same reason plugins.install does).
      await manager.reloadPlugins()
      return result
    },
    'skills.setEnabled': async (req) => {
      if (!repos.customSkills.byName(req.name)) {
        throw { code: 'NOT_FOUND', message: 'No such skill.' } satisfies IpcError
      }
      if (req.enabled) await enableSkill(skillsStagingRoot, req.name)
      else await disableSkill(req.name)
      repos.customSkills.setEnabled(req.name, req.enabled)
      await manager.reloadPlugins()
      return repos.customSkills.list()
    },
    'skills.remove': async (req) => {
      await removeSkill(skillsStagingRoot, req.name)
      repos.customSkills.remove(req.name)
      await manager.reloadPlugins()
      return repos.customSkills.list()
    },
    /*
     * Run one, in the Skills section's own session.
     *
     * Refused unless the skill is enabled, because a disabled skill is not in
     * ~/.claude/skills and the session would answer "Unknown command" — a refusal
     * that names the reason beats a session reporting a mystery.
     */
    'skills.run': async (req) => {
      const skill = repos.customSkills.byName(req.name)
      if (!skill) throw { code: 'NOT_FOUND', message: 'No such skill.' } satisfies IpcError
      if (!skill.enabled) {
        throw {
          code: 'RULE_NOT_ALLOWED',
          message: 'That skill is switched off. Turn it on in Settings, then run it.',
        } satisfies IpcError
      }
      const session = await manager.backgroundSessionFor(req.projectId, 'skills')
      const argument = req.argument?.trim()
      manager.sendMessage(session.id, argument ? `/${skill.name} ${argument}` : `/${skill.name}`)
      return { sessionId: session.id }
    },
    'specs.state': (req) => {
      const project = repos.projects.byId(req.projectId)
      if (!project) throw { code: 'NOT_FOUND', message: 'Project not found' } satisfies IpcError
      return readSpecKitState(project.path)
    },
    'specs.detail': (req) => {
      const project = repos.projects.byId(req.projectId)
      if (!project) throw { code: 'NOT_FOUND', message: 'Project not found' } satisfies IpcError
      return readSpecDetail(project.path, req.specId)
    },
    'specs.install': async (req) => {
      const project = repos.projects.byId(req.projectId)
      if (!project) throw { code: 'NOT_FOUND', message: 'Project not found' } satisfies IpcError
      await installSpecKit(project.path)
      return readSpecKitState(project.path)
    },
    'diff.list': (req) => {
      const project = repos.projects.byId(req.projectId)
      if (!project) throw { code: 'NOT_FOUND', message: 'Project not found' } satisfies IpcError
      if (!manager.liveEntryForProject(req.projectId)) {
        throw { code: 'NOT_LIVE', message: 'No live session for this project' } satisfies IpcError
      }
      return readDiffList(project.path)
    },
    'diff.file': (req) => {
      const project = repos.projects.byId(req.projectId)
      if (!project) throw { code: 'NOT_FOUND', message: 'Project not found' } satisfies IpcError
      if (!manager.liveEntryForProject(req.projectId)) {
        throw { code: 'NOT_LIVE', message: 'No live session for this project' } satisfies IpcError
      }
      return readFileDiff(project.path, req.path)
    },
    /**
     * A review comment that is carried out instead of recorded.
     *
     * Sent to the section's containerised background session rather than the
     * conversation, for the same reason every other section uses that one: the
     * developer is in the middle of something in the chat, and an edit dispatched
     * into it would queue behind whatever is being said and then reply into it.
     *
     * NOT_LIVE is deliberately the same guard the rest of this tab carries. The
     * whole feature reads a working tree that only a live project has, and the
     * background session is started against that project — offering to apply a
     * comment to a project that is not running would start one silently.
     */
    'diff.apply': async (req) => {
      const project = repos.projects.byId(req.projectId)
      if (!project) throw { code: 'NOT_FOUND', message: 'Project not found' } satisfies IpcError
      if (!manager.liveEntryForProject(req.projectId)) {
        throw { code: 'NOT_LIVE', message: 'No live session for this project' } satisfies IpcError
      }
      const instruction = req.instruction.trim()
      if (!instruction) {
        throw { code: 'INVALID_PATH', message: 'Say what to change' } satisfies IpcError
      }
      if (req.lines.length === 0) {
        throw { code: 'INVALID_PATH', message: 'Select at least one line' } satisfies IpcError
      }
      // Resolved through the same guard as opening a diagram: `path` crosses from
      // the renderer, and this one ends in an instruction to edit that file.
      const target = resolve(project.path, req.path)
      if (target !== project.path && !target.startsWith(project.path + sep)) {
        throw {
          code: 'INVALID_PATH',
          message: 'That file is outside the project',
        } satisfies IpcError
      }
      const session = await manager.backgroundSessionFor(req.projectId, 'diff')
      manager.sendMessage(
        session.id,
        applyToRegionPrompt({ path: req.path, lines: req.lines, instruction }),
      )
      return { sessionId: session.id }
    },
    // The folder IS the list (see DiagramRequestsRepo): a missing docs/diagrams is
    // a project that has generated nothing, not a failure. Requests join onto
    // whatever mtime/readdir found, so a hand-dropped or pre-app file still lists,
    // with nulls for what the app never learned.
    'diagrams.list': async (req) => {
      const project = repos.projects.byId(req.projectId)
      if (!project) throw { code: 'NOT_FOUND', message: 'Project not found' } satisfies IpcError
      // The listing itself lives in main/diagrams/list.ts: the push that fires
      // when a drawing session finishes its turn answers the same question, and
      // two copies of it would eventually disagree about one folder.
      return readDiagramList(project.path, repos.diagramRequests.forProject(req.projectId))
    },
    'diagrams.generate': async (req) => {
      const project = repos.projects.byId(req.projectId)
      if (!project) throw { code: 'NOT_FOUND', message: 'Project not found' } satisfies IpcError
      const dir = join(project.path, DIAGRAMS_DIR)
      const taken = existsSync(dir) ? readdirSync(dir) : []
      // A typed name wins over the sentence, and goes through the same slugifier:
      // the result can only ever be [a-z0-9-] plus `.html`, so a name carrying a
      // separator, a dot-dot or an extension cannot reach the filesystem as one.
      // Still uniquified, so naming a second diagram the same thing is a revision
      // rather than an overwrite of the first.
      const typed = req.name?.trim()
      const file = typed
        ? diagramFileName(typed, taken, 12)
        : diagramFileName(req.description, taken)
      // Never the chat session. Drawing a diagram is a long turn whose output the
      // developer wants to LOOK at, not watch arrive, and queued into the
      // conversation it would block whatever they were actually doing.
      //
      // And no longer the Tests session either: this is diagramSessionFor, which
      // is the project's own drawing session and nothing else's. Sharing one with
      // verification meant a diagram queued behind a suite run and the section
      // said "drawing…" for as long as the suites took. See its doc comment for
      // what isolation costs against MAX_CONTAINERS.
      const session = await manager.diagramSessionFor(req.projectId)
      // Recorded before the prompt is sent, so a crash mid-generation still leaves
      // the reason the file appeared (see DiagramRequestsRepo.record).
      repos.diagramRequests.record(req.projectId, file, req.description, session.id)
      // Registered BEFORE the prompt, and that ordering is the whole point: the
      // session is a background session, and a background session with nothing
      // outstanding gets closed as idle. Three real drawings were stopped four
      // seconds in because nothing said one was under way. See watchDiagram.
      manager.watchDiagram(session.id, file)
      // Which engine, decided by the caller rather than read from Settings here.
      // The section can be switched to archify while a request for the other one
      // is still in flight, and a handler that looked the preference up would
      // then send the wrong prompt for the file name it already recorded.
      manager.sendMessage(
        session.id,
        req.archify
          ? archifyPrompt(req.description, file, req.archify)
          : diagramPrompt(req.description, file),
      )
      return { sessionId: session.id, file }
    },
    // Trust boundary: `file` arrives from the renderer, so it is proven to sit
    // directly inside the project's own diagrams folder before anything opens it,
    // rather than trusted to already be a bare name.
    'diagrams.open': async (req) => {
      const openError = await shell.openPath(diagramPath(repos, req.projectId, req.file))
      if (openError) throw { code: 'INVALID_PATH', message: openError } satisfies IpcError
    },
    'diagrams.read': async (req) => {
      const target = diagramPath(repos, req.projectId, req.file)
      // A diagram is one page of inline SVG. A file this size is not one, and
      // reading it would push megabytes of string across the bridge to render
      // something no one asked to see.
      const MAX_BYTES = 8 * 1024 * 1024
      // Stat before read, not read-then-check: an oversized file must be
      // refused without ever pulling it into memory, and a stat that throws
      // (missing file) folds into the same refusal existsSync used to produce.
      // Both readFileSync and existsSync/statSync used to run synchronously on
      // the main thread; fs/promises moves both off it.
      let size: number
      try {
        size = (await stat(target)).size
      } catch {
        throw { code: 'NOT_FOUND', message: 'That diagram is missing or too large to show' } satisfies IpcError
      }
      if (size > MAX_BYTES) {
        throw { code: 'NOT_FOUND', message: 'That diagram is missing or too large to show' } satisfies IpcError
      }
      return { html: await readFile(target, 'utf8') }
    },
    'mcp.readSchema': (req) => {
      const project = repos.projects.byId(req.projectId)
      if (!project) throw { code: 'NOT_FOUND', message: 'Project not found' } satisfies IpcError
      const content = req.servers?.length
        ? readComboDoc(project.path, req.servers)
        : readSchemaDoc(project.path)
      return { content }
    },
    'mcp.scanHistory': (req) => repos.mcpScans.listForProject(req.projectId),
    'mcp.recordScan': async (req) => {
      const project = repos.projects.byId(req.projectId)
      if (!project) throw { code: 'NOT_FOUND', message: 'Project not found' } satisfies IpcError
      // Only record when the scan actually produced the combination's doc, and
      // date the row from the doc's mtime — a re-scan that wrote nothing keeps
      // the honest older timestamp instead of passing itself off as fresh.
      if (!req.servers.length) return null
      const docPath = comboDocPath(project.path, req.servers)
      // existsSync + statSync used to run synchronously here; a stat that
      // rejects (missing doc) folds into the same "nothing to record" null the
      // existsSync check used to return.
      let scannedAt: string
      try {
        scannedAt = (await stat(docPath)).mtime.toISOString()
      } catch {
        return null
      }
      return repos.mcpScans.upsert(req.projectId, comboKey(req.servers), req.servers, scannedAt)
    },
    'specs.runInSession': async (req) => {
      const session = req.background
        ? await manager.backgroundSessionFor(req.projectId, req.kind ?? 'spec')
        : (repos.sessions.activeForProject(req.projectId) ??
          (await manager.startSession(req.projectId)))
      // A diagram command dispatched from the Diagrams tab. Registered so the
      // section is told the moment that turn ends, exactly as the Generate
      // button already is: without it, a diagram written by a plugin command
      // fired no push at all, and the folder it landed in was only re-read on
      // some later, unrelated load. Same watch, so the two paths cannot drift.
      if (req.watchDiagrams) manager.watchDiagram(session.id)
      manager.sendMessage(session.id, req.text)
      return { sessionId: session.id }
    },
    // Eval loop: the row is the whole record for a small change. A rating is the
    // developer's own (FR-089), so it is stored exactly as given; the app never
    // derives one, and an unrun check stays 'not_run' rather than passing.
    'evals.list': (req) => repos.evals.listForProject(req.projectId),
    'evals.add': (req) => {
      const acceptance = req.acceptance.trim()
      if (!acceptance) throw { code: 'INVALID_PATH', message: 'Write what is observably true when it works.' } satisfies IpcError
      repos.evals.add(req.projectId, acceptance, req.checkCmd)
      return repos.evals.listForProject(req.projectId)
    },
    'evals.record': (req) => {
      if (req.rating != null && (req.rating < 1 || req.rating > 5)) {
        throw { code: 'INVALID_PATH', message: 'A rating is 1 to 5.' } satisfies IpcError
      }
      if (req.attempts != null && (req.attempts < 1 || req.attempts > 5)) {
        throw { code: 'INVALID_PATH', message: 'Attempts are 1 to 5.' } satisfies IpcError
      }
      // The gate: a PASS verdict needs the check to have passed (FR-087). Nothing
      // in the UI offers it otherwise, and the rule is enforced here too so it
      // cannot be bypassed by a caller.
      if (req.verdict === 'pass') {
        const current = repos.evals.byId(req.id)
        if (current && !canPassEval(current)) {
          throw {
            code: 'CONFIRM_REQUIRED',
            message: 'The check has not passed yet — run it, or mark this line failed.',
          } satisfies IpcError
        }
      }
      const updated = repos.evals.update(req.id, {
        checkStatus: req.checkStatus,
        verdict: req.verdict,
        rating: req.rating,
        note: req.note,
        attempts: req.attempts,
      })
      if (!updated) throw { code: 'NOT_FOUND', message: 'That acceptance line no longer exists.' } satisfies IpcError
      return repos.evals.listForProject(req.projectId)
    },
    'evals.remove': (req) => {
      repos.evals.remove(req.id)
      return repos.evals.listForProject(req.projectId)
    },
    // What this project can be tested with, from its own tooling — the app
    // writes no runners, it only knows the commands (FR-035/FR-037).
    'evals.suites': async (req) => {
      const project = repos.projects.byId(req.projectId)
      if (!project) throw { code: 'NOT_FOUND', message: 'Project not found' } satisfies IpcError
      try {
        // Root plus one level: a solution often sits in a subfolder of the
        // folder the developer registered.
        //
        // The reader narrows a .NET project to what it actually is — an API, a
        // Blazor front end, or both — so it is not offered suites that prove
        // nothing about it. A file that will not open reads as absent evidence,
        // never as a detection failure.
        //
        // stackEntries and detectStacks both take a SYNCHRONOUS reader (pinned
        // by test-catalog.spec.ts, and shared with the sandbox-image decision,
        // which has no async budget either), so the actual directory and file
        // reads happen up front here, off the main thread, into plain Maps —
        // see preReadStackEntries above. The closures handed to the two
        // functions below do nothing but look an already-fetched answer up.
        const listing = await preReadStackEntries(project.path)
        const entries = stackEntries(project.path, (dir) => {
          const found = listing.get(dir)
          if (found === undefined) throw new Error(`not listed: ${dir}`)
          return found
        })
        // The only files detectStacks might actually open: .csproj/Program.cs/
        // Startup.cs for app-shape detection, package.json for the
        // coverage-provider check (detectAppShapes/hasCoverageProvider in
        // test-catalog.ts). Reading every match up front is simpler than
        // mirroring that file's own slicing a second time, and a handful of
        // small reads at a project root is cheap next to what it replaces.
        const candidates = entries.filter((entry) => {
          const lower = entry.toLowerCase()
          return (
            lower.endsWith('.csproj') ||
            lower.endsWith('program.cs') ||
            lower.endsWith('startup.cs') ||
            /(^|[/\\])package\.json$/.test(lower)
          )
        })
        const contents = new Map<string, string | null>()
        await Promise.all(
          candidates.map(async (entry) => {
            // Unreadable reads as absent evidence, never as a detection
            // failure — the same rule the old readFileSync-in-a-try/catch
            // enforced.
            contents.set(entry, await readFile(join(project.path, entry), 'utf8').catch(() => null))
          }),
        )
        return detectStacks(entries, (entry) => contents.get(entry) ?? null)
      } catch {
        // Unreadable folder (removed, permissions): no stack, not a crash.
        return []
      }
    },
    // Implement / verify / review, all through the session (FR-041). A check and
    // a judge pass are watched for their reported result; attempts only records
    // how many were asked for — the developer picks the winner.
    'evals.dispatch': async (req) => {
      const run = repos.evals.byId(req.id)
      if (!run) throw { code: 'NOT_FOUND', message: 'That acceptance line no longer exists.' } satisfies IpcError
      if (req.kind === 'check' && !run.checkCmd) {
        throw { code: 'INVALID_PATH', message: 'This line has no check — use the manual pass.' } satisfies IpcError
      }
      const text =
        req.kind === 'check'
          ? checkPrompt(run.acceptance, run.checkCmd as string)
          : req.kind === 'attempts'
            ? attemptsPrompt(run.acceptance, run.checkCmd, run.attempts)
            : judgePrompt(run.acceptance)
      // Same dedicated session the verification runs use: a check or a judge pass
      // is Tests-section work, and Tests-section work does not queue behind the
      // developer's conversation.
      const session = await manager.backgroundSessionFor(req.projectId, 'tests')
      // Re-running a check clears the previous outcome, so a stale PASS can never
      // stand in for the run that is only just starting.
      if (req.kind === 'check') repos.evals.update(req.id, { checkStatus: 'not_run' })
      if (req.kind === 'judge') repos.evals.update(req.id, { judge: null })
      if (req.kind !== 'attempts') manager.watchEvalMarker(session.id, req.id, req.kind)
      manager.sendMessage(session.id, text)
      return { sessionId: session.id, runs: repos.evals.listForProject(req.projectId) }
    },
    // Verification runs: the session executes the suites and reports one result
    // line; the run row is what the gates and panels read. Nothing here parses a
    // coverage file or calls a quality service — the session already has the
    // tools, and the app never invents a figure it did not measure (FR-072).
    'verify.list': (req) => repos.verifyRuns.listForProject(req.projectId),
    'verify.start': async (req) => {
      const stack = stackById(req.stackId)
      if (!stack) throw { code: 'NOT_FOUND', message: 'Unknown stack.' } satisfies IpcError
      // The project's own verify session, not whichever session happens to be
      // open. A run is a long turn; in the chat session it blocks the
      // conversation for its whole duration. See SessionManager.verifySessionFor.
      //
      // NOT opened at all for an isolated run, and that is load-bearing rather
      // than tidiness. An isolated run never sends this session anything —
      // runSuitesIsolated opens and closes one container per suite — so a
      // session opened here purely for its facts would be a background session
      // that never runs a turn, and endIfIdleBackground only closes one that
      // HAS (`if (!entry.ranATurn) return`). It could therefore never be
      // reclaimed, and it would hold one of only two machine-wide container
      // slots for the rest of the process. The two facts it was being opened
      // for are both available without it, below.
      const session = req.isolated ? null : await manager.backgroundSessionFor(req.projectId, 'tests')
      const project = repos.projects.byId(req.projectId)
      // What the suites will actually run INSIDE, so an environment limit is
      // named before the run rather than reported afterwards as a failure of the
      // developer's code (FR-057).
      //
      // Read from the project rather than from a session on the isolated path:
      // every isolated suite is containerised by construction (runSuitesIsolated
      // passes `containerised: true`), whichever permission mode the project
      // uses, so the container's toolset is decided by the project's own stack
      // and not by whether some session happens to be a bypass one.
      const sandboxed =
        project && (req.isolated || session?.bypassPermissions === true)
          ? sandboxToolsFor(project.path)
          : null
      // A command the developer corrected for this project's layout replaces the
      // catalogue's guess. Applied here as well as in the panel so what runs is
      // exactly what the chip said it would run; suite ids are untouched, so gate
      // matching is unaffected.
      const overrides = repos.settings.get().projectSuiteCommands?.[req.projectId] ?? {}
      const suites = stack.suites.map((suite) =>
        overrides[suite.id] ? { ...suite, command: overrides[suite.id] } : suite,
      )
      const plan = planSuites(suites, req.suiteIds, sandboxed)
      if (plan.length === 0) {
        throw { code: 'INVALID_PATH', message: 'Choose at least one suite to run.' } satisfies IpcError
      }
      if (plan.every((p) => p.unavailable)) {
        throw {
          code: 'INVALID_PATH',
          message: 'None of the chosen suites can run in the bypass container — end it, or pick node suites.',
        } satisfies IpcError
      }
      const run = repos.verifyRuns.start({
        projectId: req.projectId,
        stackId: stack.id,
        // Isolated: no single session runs this run. Each suite gets its OWN
        // fresh container in turn (SessionManager.runSuitesIsolated), so there
        // is no session whose transcript the row could honestly point at —
        // `sessionId` is nullable already (VerifyRun / verifyRuns.start both
        // type it `string | null`), and that is exactly the case it exists for.
        //
        // The alternative — storing the shared background session's id here,
        // the one opened just above for its sandbox/MCP facts — was rejected:
        // nothing on the isolated path ever sends that session a message, so
        // the panel's MiniTerminal would sit under the "verifying" label
        // showing either nothing, or worse, whatever unrelated conversation
        // that shared session already had before this run started. A stalled-
        // looking terminal is a worse failure than no terminal, and TestsView's
        // own `v-if="running && latest?.sessionId"` already treats a missing
        // one as "nothing to show" rather than crashing — so this needs no
        // renderer change, only the note that an isolated run's progress
        // reaches the panel exclusively through the suite-by-suite
        // `push.verifyChanged` updates, with no live terminal alongside them.
        sessionId: session?.id ?? null,
        // No session, so no branch to read off one. The run is still traceable
        // by its own suite results; the branch label is the one fidelity an
        // isolated run gives up for not stranding a container.
        branch: session?.branch ?? null,
        requested: plan.map((p) => p.suite.id),
      })
      // Database MCP servers the run can actually reach: named in settings AND
      // reporting connected on this session. A name that is configured but absent
      // must not be offered, or the session queries a server that is not there.
      //
      // This waits, because it has to: when the session above was just started,
      // its server list has not arrived yet, and reading it immediately would name
      // nothing at all. See SessionManager.connectedMcpServers.
      //
      // On the isolated path there is no shared session to ask, and asking one
      // would be the wrong question anyway: each suite runs in its OWN fresh
      // container, and what that container has connected is a fact only it can
      // report. So the configured names travel down as the WANTED list and
      // runSuitesIsolated narrows them per suite, against the session actually
      // about to run it.
      const configured = repos.settings.get().databaseMcpServers ?? []
      const dbServers =
        req.isolated || !session ? configured : await manager.connectedMcpServers(session.id, configured)
      if (req.isolated) {
        // Fire-and-forget, on purpose (the contract requires it): this handler
        // must hand the caller its runs list immediately, and the queue this
        // starts can run for as long as every chosen suite takes to boot a
        // fresh container, run, and tear it down — strictly one at a time by
        // design, never in parallel, so a heavy suite's container going down
        // cannot take a sibling's memory with it. Suite results land through
        // the same repos.verifyRuns.noteSuite the combined-container run's
        // SWB_SUITE lines already use, and the run closes once at the end
        // through the same finish() — no new table, no new column.
        void manager.runSuitesIsolated({
          runId: run.id,
          projectId: req.projectId,
          plan,
          stackLabel: stack.label,
          sandboxed,
          dbServers,
        })
      } else if (session) {
        // `session` is non-null on this branch by construction — it is created
        // above exactly when `isolated` is false. Narrowed with a real check
        // rather than an assertion, because the two conditions are the same
        // fact expressed twice and a cast is how they would quietly drift
        // apart later.
        manager.watchVerifyReport(session.id, run.id, 'suites')
        manager.sendMessage(session.id, verifyPrompt(plan, stack.label, sandboxed, dbServers))
      }
      // The response's own `sessionId` is unchanged by `isolated`: it names the
      // background session this call used to plan the run (sandbox facts, MCP
      // servers), not the run's own `sessionId` column, which is where the
      // isolated/shared distinction actually lives. Nothing in the renderer
      // reads this field today (verify.ts's store destructures only `runs`),
      // and the response shape is fixed by the contract regardless.
      // Null on the isolated path: this call opened no session, because each
      // suite opens and closes its own. Nothing in the renderer reads this
      // field (verify.ts destructures only `runs`), and the contract types it
      // as part of the response rather than as a promise that one exists.
      return { sessionId: session?.id ?? null, runs: repos.verifyRuns.listForProject(req.projectId) }
    },
    'verify.evidence': async (req) => {
      const run = req.runId
        ? repos.verifyRuns.byId(req.runId)
        : (repos.verifyRuns.listForProject(req.projectId)[0] ?? null)
      if (!run) {
        throw { code: 'NOT_FOUND', message: 'Run a verification pass first — evidence attaches to a run.' } satisfies IpcError
      }
      // Evidence attaches to one specific run, so it goes back to the session
      // that produced it while that session is still alive — the run is already
      // in its context. Otherwise it takes a fresh verify session like any run.
      const ran = run.sessionId ? repos.sessions.byId(run.sessionId) : undefined
      const session =
        ran && !ran.endedAt ? ran : await manager.backgroundSessionFor(req.projectId, 'tests')
      // The acceptance lines still waiting on a verdict say what the evidence has
      // to show; without any, the session works from the diff alone.
      const hints = repos.evals
        .listForProject(req.projectId)
        .filter((line) => line.verdict === 'pending')
        .slice(0, 5)
        .map((line) => line.acceptance)
      manager.watchVerifyReport(session.id, run.id, 'evidence')
      manager.sendMessage(session.id, evidencePrompt(hints, session.bypassPermissions === true))
      return { sessionId: session.id, runs: repos.verifyRuns.listForProject(req.projectId) }
    },
    'verify.cancel': async (req) => {
      await manager.cancelVerifyRun(req.runId)
      return repos.verifyRuns.listForProject(req.projectId)
    },
    'api.cancel': async (req) => {
      await manager.cancelApiRun(req.runId)
      return repos.apiRuns.listForProject(req.projectId)
    },
    // The API eval set (deterministic path). Everything the app can establish
    // itself, it establishes itself: the routes come from a scan of the project's
    // source, the calls are made by the app, and the verdict is computed from the
    // statuses that came back. The session is used for one thing only — request
    // data drawn from real rows (api-dispatch.ts).
    'api.endpoints': async (req) => {
      const project = repos.projects.byId(req.projectId)
      if (!project) throw { code: 'NOT_FOUND', message: 'Project not found' } satisfies IpcError
      const scan = await scanProjectEndpoints(project.path)
      const settings = repos.settings.get()
      const host = await resolveApiHost(project.path, {
        baseUrl: settings.projectApiBase[req.projectId],
        startCmd: settings.projectApiStart[req.projectId],
      })
      const qaUrl = settings.projectApiQa[req.projectId] ?? null
      const qaHeaders = settings.projectApiQaHeaders[req.projectId] ?? null
      // Resolved now so an unset environment variable is a sentence in the panel
      // before the run, not a wall of 401s after it. Only the error travels — the
      // resolved values stay in the main process.
      const qa = qaUrl
        ? await resolveApiHost(project.path, {
            target: 'qa',
            qaBaseUrl: qaUrl,
            qaHeaders: qaHeaders ?? undefined,
          })
        : null
      return {
        endpoints: scan.endpoints,
        recent: recentEndpoints(repos.apiRuns.listForProject(req.projectId)),
        filesRead: scan.filesRead,
        truncated: scan.truncated,
        host:
          'error' in host
            ? { baseUrl: null, startCmd: null, from: null, error: host.error }
            : { baseUrl: host.baseUrl, startCmd: host.startCmd, from: host.from, error: null },
        qa: {
          baseUrl: qaUrl,
          headers: qaHeaders,
          error: qa && 'error' in qa ? qa.error : null,
        },
      }
    },
    'api.runs': (req) => repos.apiRuns.listForProject(req.projectId),
    'api.start': async (req) => {
      const project = repos.projects.byId(req.projectId)
      if (!project) throw { code: 'NOT_FOUND', message: 'Project not found' } satisfies IpcError
      if (req.endpoints.length === 0) {
        throw { code: 'INVALID_PATH', message: 'Choose at least one endpoint to test.' } satisfies IpcError
      }
      const settings = repos.settings.get()
      const target = req.target ?? 'local'
      // Resolved BEFORE the session is touched: a project with nowhere to call is
      // a sentence the developer can act on, not a run that starts and then fails.
      // For QA that includes the headers, so a missing API-key variable is caught
      // here rather than after the environment has rejected every call.
      const host = await resolveApiHost(project.path, {
        target,
        baseUrl: settings.projectApiBase[req.projectId],
        startCmd: settings.projectApiStart[req.projectId],
        qaBaseUrl: settings.projectApiQa[req.projectId],
        qaHeaders: settings.projectApiQaHeaders[req.projectId],
      })
      if ('error' in host) throw { code: 'INVALID_PATH', message: host.error } satisfies IpcError
      // The Tests section's own session, shared with verification runs. See
      // SessionManager.backgroundSessionFor.
      const session = await manager.backgroundSessionFor(req.projectId, 'tests')
      const run = repos.apiRuns.start({
        projectId: req.projectId,
        baseUrl: host.baseUrl,
        target: host.target,
        sessionId: session.id,
      })
      manager.watchApiRequests(session.id, run.id)
      // Same wait as a verification run: a session started a moment ago has not
      // reported its MCP servers yet, so reading the list immediately names none.
      const dbServers = await manager.connectedMcpServers(
        session.id,
        settings.databaseMcpServers ?? [],
      )
      manager.sendMessage(
        session.id,
        apiDataPrompt(req.endpoints, dbServers, { target: host.target, baseUrl: host.baseUrl }),
      )
      return { sessionId: session.id, runs: repos.apiRuns.listForProject(req.projectId) }
    },
    'api.setHost': (req) => {
      const settings = repos.settings.get()
      const base = { ...settings.projectApiBase }
      const start = { ...settings.projectApiStart }
      const qa = { ...settings.projectApiQa }
      const qaHeaders = { ...settings.projectApiQaHeaders }
      // An empty string clears the override, which is what an emptied field means.
      if (req.baseUrl !== undefined) {
        if (req.baseUrl.trim()) base[req.projectId] = req.baseUrl.trim()
        else delete base[req.projectId]
      }
      if (req.startCmd !== undefined) {
        if (req.startCmd.trim()) start[req.projectId] = req.startCmd.trim()
        else delete start[req.projectId]
      }
      if (req.qaBaseUrl !== undefined) {
        if (req.qaBaseUrl.trim()) qa[req.projectId] = req.qaBaseUrl.trim()
        else delete qa[req.projectId]
      }
      if (req.qaHeaders !== undefined) {
        // Not trimmed to a single line: these are `Name: value` lines, and the
        // whole block is what the developer typed.
        if (req.qaHeaders.trim()) qaHeaders[req.projectId] = req.qaHeaders.trim()
        else delete qaHeaders[req.projectId]
      }
      return repos.settings.set({
        projectApiBase: base,
        projectApiStart: start,
        projectApiQa: qa,
        projectApiQaHeaders: qaHeaders,
      })
    },
    // The report for a finished run: written from the recorded calls alone, so it
    // is a transcript of what happened rather than an account of it.
    'api.report': async (req) => {
      const project = repos.projects.byId(req.projectId)
      if (!project) throw { code: 'NOT_FOUND', message: 'Project not found' } satisfies IpcError
      const run = req.runId
        ? repos.apiRuns.byId(req.runId)
        : (repos.apiRuns.listForProject(req.projectId)[0] ?? null)
      if (!run) {
        throw {
          code: 'NOT_FOUND',
          message: 'Run an API eval set first — a report is written from a run.',
        } satisfies IpcError
      }
      if (run.status === 'running') {
        throw {
          code: 'INVALID_PATH',
          message: 'That run is still going. Its report is written once the calls are in.',
        } satisfies IpcError
      }
      const dir = join(project.path, '.switchboard', 'reports')
      // mkdirSync + writeFileSync used to run synchronously here, on the main
      // thread, for what can be a several-KB markdown file.
      await mkdir(dir, { recursive: true })
      const path = join(dir, apiReportFileName(run))
      await writeFile(
        path,
        apiReportMarkdown(run, {
          projectName: project.name,
          dbServers: repos.settings.get().databaseMcpServers ?? [],
        }),
        'utf8',
      )
      return { path }
    },
    'queue.list': (req) => manager.listQueue(req.projectId),
    'queue.add': (req) => {
      manager.enqueueTask(req.projectId, req.text)
      return manager.listQueue(req.projectId)
    },
    'queue.edit': (req) => {
      manager.editTask(req.projectId, req.id, req.text)
      return manager.listQueue(req.projectId)
    },
    'queue.remove': (req) => {
      manager.removeTask(req.projectId, req.id)
      return manager.listQueue(req.projectId)
    },
    'inbox.pending': () => repos.requests.pending(),
    'inbox.decide': (req) => broker.decide(req.requestId, req.decision, req.confirmHighRisk ?? false),
    'inbox.alwaysAllow': (req) => {
      const { rule } = broker.alwaysAllow(req.requestId)
      return { rule }
    },
    'inbox.approveAlways': (req) => broker.approveAlways(req.requestId, req.confirmHighRisk ?? false),
    'inbox.approveAllForProject': (req) =>
      broker.approveAllForProject(req.projectId, req.includeHighRisk ?? false),
    'inbox.history': (req) => repos.requests.history(req),
    'inbox.deleteHistory': (req) => {
      repos.requests.deleteHistory(req.requestId)
    },
    'inbox.clearHistory': () => {
      repos.requests.clearHistory()
    },
    // Rules the developer owns (PRODUCT.md Principle 3). Every mutation reloads
    // the cached rule set before answering, so the change reaches sessions that
    // are already running: a noise rule switched off stops hiding output now.
    'rules.list': () => rulesView(repos.rulePrefs.list()),
    'rules.setDisabled': (req) => {
      repos.rulePrefs.setDisabled(req.id, req.kind, req.disabled)
      return applyRules()
    },
    'rules.setRisk': (req) => {
      repos.rulePrefs.setRisk(req.id, req.risk)
      return applyRules()
    },
    'rules.addRisk': (req) => {
      const toolMatcher = req.toolMatcher.trim()
      if (!toolMatcher) {
        throw { code: 'INVALID_PATH', message: 'Name a tool, or * for every tool' } satisfies IpcError
      }
      const pattern = req.pattern?.trim() || null
      // Rejected here rather than at match time: classifyRisk swallows a bad
      // pattern as "never matches", so an unusable rule would look saved and
      // silently do nothing.
      if (pattern !== null && !isValidRegExp(pattern)) {
        throw { code: 'INVALID_PATH', message: 'That pattern is not a valid regular expression' } satisfies IpcError
      }
      repos.rulePrefs.addCustom(
        'risk',
        JSON.stringify({
          scope: 'global',
          position: 0,
          toolMatcher,
          inputMatcher: pattern ? { field: 'command', pattern } : null,
          risk: req.risk,
          builtin: false,
        }),
      )
      return applyRules()
    },
    'rules.addSwallow': (req) => {
      const pattern = req.pattern.trim()
      const noiseKind = req.noiseKind.trim()
      if (!pattern) throw { code: 'INVALID_PATH', message: 'Enter a pattern' } satisfies IpcError
      if (!isValidRegExp(pattern)) {
        throw { code: 'INVALID_PATH', message: 'That pattern is not a valid regular expression' } satisfies IpcError
      }
      if (!noiseKind) {
        throw { code: 'INVALID_PATH', message: 'Name what this hides, e.g. "build output"' } satisfies IpcError
      }
      repos.rulePrefs.addCustom(
        'swallow',
        JSON.stringify({
          position: 0,
          eventKindMatcher: req.eventKindMatcher,
          pattern,
          noiseKind,
          enabled: true,
        }),
      )
      return applyRules()
    },
    'rules.remove': (req) => {
      repos.rulePrefs.remove(req.id, req.kind)
      return applyRules()
    },
    'rules.standing.list': (req) =>
      repos.standingRules.listForProject(req.projectId, req.includeRevoked ?? false),
    'rules.standing.revoke': (req) => {
      repos.standingRules.revoke(req.ruleId)
    },
    'rules.standing.restore': (req) => {
      repos.standingRules.restore(req.ruleId)
    },
    'rules.standing.add': (req) => {
      const pattern = req.pattern.trim()
      if (!pattern) throw { code: 'INVALID_PATH', message: 'Enter a command' } satisfies IpcError
      // The same refusal the broker applies when a rule is created from an
      // approval. Three places write standing rules and only two enforced this,
      // so the box in Settings could grant `rm -rf` or `git push --force` a
      // permanent auto-approval that the inbox itself would never create.
      if (isDangerousCommand(pattern)) {
        throw {
          code: 'INVALID_PATH',
          message: `"${pattern}" is destructive, so it cannot be always-allowed. Approve it once, each time, from the inbox.`,
        } satisfies IpcError
      }
      return repos.standingRules.insert({
        projectId: req.projectId,
        toolName: 'Bash',
        matcher: { kind: 'command_prefix', value: pattern },
        createdFromRequestId: 'manual',
      })
    },
    // Host-side, and deliberately not a session message: see plugin-install.ts.
    // Awaited to completion so the renderer learns whether it actually worked.
    'plugins.install': async (req) => {
      // Checked against the catalogue before the CLI ever sees these strings —
      // see ALLOWED_PLUGINS above for why an unlisted pair is refused rather
      // than passed through.
      if (!ALLOWED_PLUGINS.has(`${req.marketplace}|${req.pkg}`)) {
        throw {
          code: 'RULE_NOT_ALLOWED',
          message: 'That plugin is not one this app offers to install.',
        } satisfies IpcError
      }
      await installPlugin(req.marketplace, req.pkg)
      // The install happened on the host, outside every session, so nothing else
      // would ever tell them. Without this the card that just installed a plugin
      // carries on offering to install it until a new session starts.
      await manager.reloadPlugins()
    },
    'settings.get': () => repos.settings.get(),
    'settings.set': (req) => repos.settings.set(req),
    'models.available': () => manager.models(),
    'updates.check': async () => ({ status: await checkForUpdates() }),
    'updates.install': () => installNow(),
  }

  ipcMain.handle(
    INVOKE_CHANNEL,
    async (event, method: InvokeMethod, req: unknown): Promise<WireResult<unknown>> => {
      // Accept IPC only from the app's own main window, and only from its TOP
      // frame (A17). The webContents check alone is not the whole answer: any
      // frame inside those contents — an iframe, an embed — shares the same
      // webContents id and would have passed it. Comparing the sending frame to
      // mainFrame is what makes "the app's own UI" the actual test.
      //
      // Fails closed: senderFrame is null once a frame has been disposed, which
      // is not something the app's live window is, so it is rejected too.
      const trusted = deps.getWindow()
      if (
        !trusted ||
        event.sender.id !== trusted.webContents.id ||
        event.senderFrame !== trusted.webContents.mainFrame
      ) {
        return { ok: false, error: { code: 'INTERNAL', message: 'Untrusted IPC sender' } }
      }
      // Object.hasOwn, not a truthy `handlers[method]` lookup: `handlers` is a
      // plain object, so `method` values like "constructor" or "toString" that
      // never appear in InvokeMap still resolve through the prototype chain and
      // pass a truthy check — handing the request straight to Object.prototype's
      // own method. Unreachable today because the sender-trust check above runs
      // first and every real caller is InvokeMethod-typed, but `method` is still
      // an unvalidated string crossing a trust boundary, and a dynamic property
      // lookup on one should never trust the prototype chain to stay empty.
      if (!Object.hasOwn(handlers, method)) {
        return { ok: false, error: { code: 'NOT_FOUND', message: `Unknown method ${method}` } }
      }
      const handler = handlers[method]
      try {
        const value = await (handler as (r: unknown) => unknown)(req)
        return { ok: true, value: value ?? null }
      } catch (error) {
        return { ok: false, error: toIpcError(error) }
      }
    },
  )
}
