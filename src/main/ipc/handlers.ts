import { clipboard, dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import type { CustomSkill, KeepCurrentReport, Project, Session, SessionEvent } from '@shared/domain'
import type { SectionKind } from '@shared/domain'
import { isDangerousCommand, sessionName } from '@shared/domain'
import {
  DIAGRAM_FILE_PICKS,
  DIAGRAM_PLUGIN,
  DIAGRAMS_DIR,
  archifyPrompt,
  diagramFileName,
  diagramPrompt,
  isDiagramFilePick,
} from '@shared/diagram'
import { applyToRegionPrompt } from '@shared/diff-apply'
import type {
  Counters,
  FlowSnapshot,
  InvokeMap,
  InvokeMethod,
  IpcError,
  ProjectListItem,
  PushChannel,
  PushMap,
  WireResult,
} from '@shared/ipc-types'
import { INVOKE_CHANNEL, isIpcError, isIpcErrorCode } from '@shared/ipc-types'
import type { PtyHost } from '@main/terminal/pty-host'
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
import { existsSync, readdirSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { stackById } from '@shared/test-catalog'
import { detectProjectSuites, evidencePrompt, planSuites, verifyPrompt } from '@main/verify/verify-dispatch'
import { readComboDoc, readSchemaDoc } from '@main/mcp/schema-doc'
import { gitNotice, readDiffList, readFileDiff } from '@main/sessions/session-manager'
import { sandboxToolsFor } from '@main/sessions/wslc-sandbox'
import { readDiagramList } from '@main/diagrams/list'
import { importSkills } from '@main/skills/import'
import type { FlowSupervisor } from '@main/flow/flow-supervisor'
import { disableSkill, enableSkill, installedSkillNames, liveSkillFolders, removeSkill } from '@main/skills/install'
import { detectFlowStacks } from '@main/flow/stacks'
import { check as checkForUpdates, installNow } from '@main/updater'

const EVENT_FLUSH_INTERVAL_MS = 33 
const COUNTER_DEBOUNCE_MS = 50

export class RendererPush {
  private eventBuffer: SessionEvent[] = []
  private flushTimer: NodeJS.Timeout | null = null
  private counterTimer: NodeJS.Timeout | null = null
  private terminalBuffer = new Map<string, string>()
  private terminalTimer: NodeJS.Timeout | null = null

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
      const window = this.getWindow()
      if (!window || window.isDestroyed()) return
      this.send('push.counters', this.computeCounters())
    }, COUNTER_DEBOUNCE_MS)
  }

  terminalData(id: string, data: string): void {
    this.terminalBuffer.set(id, (this.terminalBuffer.get(id) ?? '') + data)
    if (!this.terminalTimer) {
      this.terminalTimer = setTimeout(() => this.flushTerminal(), EVENT_FLUSH_INTERVAL_MS)
    }
  }

  private flushTerminal(): void {
    this.terminalTimer = null
    if (this.terminalBuffer.size === 0) return
    const window = this.getWindow()
    if (!window || window.isDestroyed()) {
      this.terminalBuffer.clear()
      return
    }
    for (const [id, data] of this.terminalBuffer) this.send('push.terminalData', { id, data })
    this.terminalBuffer.clear()
  }

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
  skillsStagingRoot: string
  flow: FlowSupervisor
  broker: PermissionBroker
  getWindow: () => BrowserWindow | null
  dbProjectId: string
  ptyHost: PtyHost
  keepCurrent: () => Promise<KeepCurrentReport>
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
    return {
      code: isIpcErrorCode(error.code) ? error.code : 'INTERNAL',
      message: error.message,
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { code: 'INTERNAL', message }
}

function diagramPath(repos: Repositories, projectId: string, file: string): string {
  const project = repos.projects.byId(projectId)
  if (!project) throw { code: 'NOT_FOUND', message: 'Project not found' } satisfies IpcError
  if (file.includes('/') || file.includes('\\') || file.includes('..') || !/\.html$/i.test(file)) {
    throw { code: 'INVALID_PATH', message: 'Not a diagram file name' } satisfies IpcError
  }
  const dir = resolve(project.path, DIAGRAMS_DIR)
  const target = resolve(dir, file)
  if (target !== dir && !target.startsWith(dir + sep)) {
    throw { code: 'INVALID_PATH', message: 'That file is outside the diagrams folder' } satisfies IpcError
  }
  return target
}

const ALLOWED_PLUGINS: ReadonlySet<string> = new Set([
  `${DIAGRAM_PLUGIN.marketplace}|${DIAGRAM_PLUGIN.pkg}`,
])

export function registerIpcHandlers(deps: HandlerDeps): void {
  const { repos, manager, broker, dbProjectId, skillsStagingRoot, ptyHost, flow } = deps

  const requireProject = (projectId: string): Project => {
    const project = repos.projects.byId(projectId)
    if (!project) throw { code: 'NOT_FOUND', message: 'Project not found' } satisfies IpcError
    return project
  }

  const listSkills = async (): Promise<CustomSkill[]> => {
    const live = new Set(await installedSkillNames())
    return repos.customSkills
      .list()
      .map((skill) => ({ ...skill, enabled: skill.enabled && live.has(skill.name) }))
  }

  const flowSnapshot = (projectId: string): FlowSnapshot => ({
    runs: repos.flowRuns.listForProject(projectId),
    stages: repos.flowStages.listForProject(projectId),
  })

  const flowSnapshotForRun = (runId: string): FlowSnapshot => {
    const run = repos.flowRuns.byId(runId)
    if (!run) throw { code: 'NOT_FOUND', message: 'Run not found' } satisfies IpcError
    return flowSnapshot(run.projectId)
  }

  const frozenName = (session: Session, work: Parameters<typeof sessionName>[1]): string | null => {
    if (session.derivedName) return session.derivedName
    const derived = sessionName(session.id, work, session.branch, session.endReason)
    if (!derived) return null
    if (!session.branch && !session.endReason) return derived
    manager.freezeDerivedName(session.id, derived)
    return derived
  }

  const projectList = (): ProjectListItem[] =>
    repos.projects.listActive().map((project) => {
      const live = manager
        .liveSessionIds()
        .map((id) => manager.liveSessionRow(id))
        .filter((s): s is Session => !!s && s.projectId === project.id)
      const latest = live.length === 0 ? repos.sessions.latestForProject(project.id) : undefined
      const rows = live.length > 0 ? live : latest ? [latest] : []
      const work = {
        verifyRunSessionIds: repos.verifyRuns
          .listForProject(project.id)
          .map((r) => r.sessionId)
          .filter((id): id is string => !!id),
        diagrams: [...repos.diagramRequests.forProject(project.id).values()],
        suites: manager.isolatedSuiteNamesFor(project.id),
        kinds: {
          ...Object.fromEntries(
            rows.filter((s) => s.sectionKind).map((s) => [s.id, s.sectionKind as SectionKind]),
          ),
          ...manager.sectionKinds(project.id),
        },
      }
      const sessions = rows.map((s) => ({ ...s, name: s.label ?? frozenName(s, work) }))
      return {
        ...project,
        session: sessions[0] ?? null,
        sessions,
        gitNotice: gitNotice(project.path),
        drafts: repos.drafts.listForProject(project.id),
        reserved: project.id === dbProjectId,
      }
    })

  const handlers: Handlers = {
    'projects.list': () => ({
      projects: projectList(),
      archived: repos.projects.listArchived(),
      counters: computeCounters(repos),
    }),
    'dialog.pickFolder': async () => {
      const opts = { title: 'Choose a project folder', properties: ['openDirectory' as const] }
      const parent = deps.getWindow()
      const picked = parent
        ? await dialog.showOpenDialog(parent, opts)
        : await dialog.showOpenDialog(opts)
      const path = picked.canceled ? undefined : picked.filePaths[0]
      return { path: path ?? null }
    },
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
    'projects.unarchive': (req) => {
      if (!repos.projects.byId(req.projectId)) {
        throw { code: 'NOT_FOUND', message: 'Project not found' } satisfies IpcError
      }
      repos.projects.unarchive(req.projectId)
    },
    'projects.delete': (req) => {
      requireProject(req.projectId)
      if (req.projectId === dbProjectId) {
        throw { code: 'RULE_NOT_ALLOWED', message: 'The Database project cannot be deleted.' } satisfies IpcError
      }
      const blocker = repos.projects.deleteBlocker(req.projectId)
      if (blocker === 'live_session') {
        throw {
          code: 'ALREADY_ACTIVE',
          message: 'It has a live session. End every session in it first.',
        } satisfies IpcError
      }
      if (blocker === 'flow_worktree') {
        throw {
          code: 'RULE_NOT_ALLOWED',
          message: 'A Flow run still owns a worktree in it. Remove that worktree from the Flow run first.',
        } satisfies IpcError
      }
      repos.events.flush()
      repos.projects.delete(req.projectId)
    },
    'projects.setUseContainers': (req) => {
      if (!repos.projects.byId(req.projectId)) {
        throw { code: 'NOT_FOUND', message: 'Project not found' } satisfies IpcError
      }
      repos.projects.setUseContainers(req.projectId, req.on)
    },
    'terminal.open': (req) => ptyHost.open(req),
    'terminal.write': (req) => ptyHost.write(req.id, req.data),
    'terminal.resize': (req) => ptyHost.resize(req.id, req.cols, req.rows),
    'terminal.close': (req) => ptyHost.close(req.id),
    'sessions.rename': (req) => manager.renameSession(req.sessionId, req.label),
    'sessions.start': (req) =>
      manager.startSession(req.projectId, req.resume ?? false, req.mode, {
        containerised: req.containerised === true,
      }),
    'clipboard.write': (req) => {
      clipboard.writeText(req.text)
    },
    'clipboard.read': () => ({ text: clipboard.readText() }),
    'sessions.setPlanMode': (req) => {
      manager.setPlanMode(req.sessionId, req.enabled)
    },
    'sessions.stop': (req) => manager.stopSession(req.sessionId, 'You ended this session.'),
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
    'sessions.clearBackgroundTasks': (req) => manager.clearBackgroundTasks(req.sessionId),
    'sessions.send': (req) => {
      const result = manager.sendMessage(req.sessionId, req.text, req.agentId)
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
    'skills.list': listSkills,
    'skills.installed': installedSkillNames,
    'skills.import': async (req) => {
      const result = await importSkills(req.url, skillsStagingRoot, new Set(await liveSkillFolders()))
      repos.customSkills.upsertMany(result.imported)
      for (const skill of result.imported) {
        try {
          await enableSkill(skillsStagingRoot, skill.name)
        } catch {
          repos.customSkills.setEnabled(skill.name, false)
        }
      }
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
      return listSkills()
    },
    'skills.remove': async (req) => {
      if (!repos.customSkills.byName(req.name)) {
        throw { code: 'NOT_FOUND', message: 'No such skill.' } satisfies IpcError
      }
      await removeSkill(skillsStagingRoot, req.name)
      repos.customSkills.remove(req.name)
      await manager.reloadPlugins()
      return listSkills()
    },
    'skills.run': async (req) => {
      requireProject(req.projectId)
      const skill = (await listSkills()).find((s) => s.name === req.name)
      if (!skill) throw { code: 'NOT_FOUND', message: 'No such skill.' } satisfies IpcError
      if (!skill.enabled) {
        throw {
          code: 'RULE_NOT_ALLOWED',
          message: 'That skill is switched off. Turn it on in Settings, Skills, then run it.',
        } satisfies IpcError
      }
      const session = await manager.backgroundSessionFor(req.projectId, 'skills')
      const argument = req.argument?.trim()
      manager.sendMessage(session.id, argument ? `/${skill.name} ${argument}` : `/${skill.name}`)
      return { sessionId: session.id }
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
    'diagrams.list': async (req) => {
      const project = repos.projects.byId(req.projectId)
      if (!project) throw { code: 'NOT_FOUND', message: 'Project not found' } satisfies IpcError
      return readDiagramList(project.path, repos.diagramRequests.forProject(req.projectId))
    },
    'diagrams.generate': async (req) => {
      const project = repos.projects.byId(req.projectId)
      if (!project) throw { code: 'NOT_FOUND', message: 'Project not found' } satisfies IpcError
      const dir = join(project.path, DIAGRAMS_DIR)
      const taken = existsSync(dir) ? readdirSync(dir) : []
      const typed = req.name?.trim()
      const file = typed
        ? diagramFileName(typed, taken, 12)
        : diagramFileName(req.description, taken)
      const session = await manager.diagramSessionFor(req.projectId)
      repos.diagramRequests.record(req.projectId, file, req.description, session.id)
      manager.watchDiagram(session.id, file)
      manager.sendMessage(
        session.id,
        req.archify
          ? archifyPrompt(req.description, file, req.archify)
          : diagramPrompt(req.description, file),
      )
      return { sessionId: session.id, file }
    },
    'diagrams.open': async (req) => {
      const openError = await shell.openPath(diagramPath(repos, req.projectId, req.file))
      if (openError) throw { code: 'INVALID_PATH', message: openError } satisfies IpcError
    },
    'diagrams.read': async (req) => {
      const target = diagramPath(repos, req.projectId, req.file)
      const MAX_BYTES = 8 * 1024 * 1024
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
    'sections.runInSession': async (req) => {
      const session = req.background
        ? await manager.backgroundSessionFor(req.projectId, req.kind)
        : (manager.foregroundEntry(req.projectId)?.row ?? (await manager.startSession(req.projectId)))
      if (req.watchDiagrams) manager.watchDiagram(session.id)
      manager.sendMessage(session.id, req.text)
      return { sessionId: session.id }
    },
    'verify.list': (req) => repos.verifyRuns.listForProject(req.projectId),
    'verify.suites': async (req) => {
      const project = repos.projects.byId(req.projectId)
      if (!project) throw { code: 'NOT_FOUND', message: 'Project not found' } satisfies IpcError
      return detectProjectSuites(project.path).catch(() => [])
    },
    'verify.start': async (req) => {
      const stack = stackById(req.stackId)
      if (!stack) throw { code: 'NOT_FOUND', message: 'Unknown stack.' } satisfies IpcError
      const session = req.isolated ? null : await manager.backgroundSessionFor(req.projectId, 'tests')
      const project = repos.projects.byId(req.projectId)
      const sandboxed =
        project && (req.isolated || (session && manager.runsInContainer(session.id)))
          ? sandboxToolsFor(project.path)
          : null
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
          message: 'None of the chosen suites can run in the container. Untick Run in Container, or pick other suites.',
        } satisfies IpcError
      }
      const run = repos.verifyRuns.start({
        projectId: req.projectId,
        stackId: stack.id,
        sessionId: session?.id ?? null,
        branch: session?.branch ?? null,
        requested: plan.map((p) => p.suite.id),
      })
      const configured = repos.settings.get().databaseMcpServers ?? []
      const dbServers =
        req.isolated || !session ? configured : await manager.connectedMcpServers(session.id, configured)
      if (req.isolated) {
        void manager.runSuitesIsolated({
          runId: run.id,
          projectId: req.projectId,
          plan,
          stackLabel: stack.label,
          sandboxed,
          dbServers,
        })
      } else if (session) {
        manager.watchVerifyReport(session.id, run.id, 'suites')
        manager.sendMessage(session.id, verifyPrompt(plan, stack.label, dbServers, sandboxed))
      }
      return { sessionId: session?.id ?? null, runs: repos.verifyRuns.listForProject(req.projectId) }
    },
    'verify.evidence': async (req) => {
      const run = req.runId
        ? repos.verifyRuns.byId(req.runId)
        : (repos.verifyRuns.listForProject(req.projectId)[0] ?? null)
      if (!run) {
        throw { code: 'NOT_FOUND', message: 'Run a verification pass first — evidence attaches to a run.' } satisfies IpcError
      }
      const ran = run.sessionId ? repos.sessions.byId(run.sessionId) : undefined
      const session =
        ran && !ran.endedAt ? ran : await manager.backgroundSessionFor(req.projectId, 'tests')
      manager.watchVerifyReport(session.id, run.id, 'evidence')
      manager.sendMessage(session.id, evidencePrompt([], manager.runsInContainer(session.id)))
      return { sessionId: session.id, runs: repos.verifyRuns.listForProject(req.projectId) }
    },
    'verify.cancel': async (req) => {
      await manager.cancelVerifyRun(req.runId)
      return repos.verifyRuns.listForProject(req.projectId)
    },
    'flow.list': (req) => flowSnapshot(req.projectId),
    'flow.features': async (req) => {
      requireProject(req.projectId)
      return flow.features(req.projectId, req.query ?? '')
    },
    'flow.existingSpecs': async (req) => {
      requireProject(req.projectId)
      return flow.existingSpecs(req.projectId)
    },
    'flow.detectStacks': async (req) => {
      const project = requireProject(req.projectId)
      return detectFlowStacks(project.path)
    },
    'flow.start': async (req) => {
      requireProject(req.projectId)
      if (req.companions?.some((companion) => companion.projectId === dbProjectId)) {
        throw { code: 'RULE_NOT_ALLOWED', message: 'The Database project cannot be part of a Flow run.' } satisfies IpcError
      }
      const run = await flow.start({
        projectId: req.projectId,
        source: req.source,
        autopilot: req.autopilot,
        autoShip: req.autoShip,
        baseBranch: req.baseBranch,
        companions: req.companions,
      })
      return { runId: run.id, ...flowSnapshot(req.projectId) }
    },
    'flow.approve': async (req) => {
      await flow.approve(req.runId)
      return flowSnapshotForRun(req.runId)
    },
    'flow.retry': async (req) => {
      await flow.retry(req.runId)
      return flowSnapshotForRun(req.runId)
    },
    'flow.skip': async (req) => {
      await flow.skip(req.runId)
      return flowSnapshotForRun(req.runId)
    },
    'flow.fix': async (req) => {
      await flow.fix(req.runId)
      return flowSnapshotForRun(req.runId)
    },
    'flow.ship': async (req) => {
      await flow.ship(req.runId)
      return flowSnapshotForRun(req.runId)
    },
    'flow.cancel': async (req) => {
      await flow.cancel(req.runId)
      return flowSnapshotForRun(req.runId)
    },
    'flow.revise': async (req) => {
      const feedback = req.feedback.trim()
      if (!feedback) throw { code: 'INVALID_PATH', message: 'Say what should change.' } satisfies IpcError
      await flow.revise(req.runId, feedback)
      return flowSnapshotForRun(req.runId)
    },
    'flow.setAutopilot': (req) => {
      flow.setAutopilot(req.runId, req.autopilot)
      return flowSnapshotForRun(req.runId)
    },
    'flow.removeWorktree': async (req) => {
      await flow.removeWorktree(req.runId, req.force === true)
      return flowSnapshotForRun(req.runId)
    },
    'flow.openPullRequest': async (req) => {
      await shell.openExternal(await flow.pullRequestUrl(req.runId, req.projectId))
    },
    'flow.artefact': async (req) => flow.artefact(req.runId, req.stage, req.kind),
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
    'plugins.install': async (req) => {
      if (!ALLOWED_PLUGINS.has(`${req.marketplace}|${req.pkg}`)) {
        throw {
          code: 'RULE_NOT_ALLOWED',
          message: 'That plugin is not one this app offers to install.',
        } satisfies IpcError
      }
      await installPlugin(req.marketplace, req.pkg)
      await manager.reloadPlugins()
    },
    'plugins.keepCurrent': () => deps.keepCurrent(),
    'settings.get': () => repos.settings.get(),
    'settings.set': (req) => repos.settings.set(req),
    'models.available': () => manager.models(),
    'updates.check': async () => ({ status: await checkForUpdates() }),
    'updates.install': () => installNow(),
  }

  ipcMain.handle(
    INVOKE_CHANNEL,
    async (event, method: InvokeMethod, req: unknown): Promise<WireResult<unknown>> => {
      const trusted = deps.getWindow()
      if (
        !trusted ||
        event.sender.id !== trusted.webContents.id ||
        event.senderFrame !== trusted.webContents.mainFrame
      ) {
        return { ok: false, error: { code: 'INTERNAL', message: 'Untrusted IPC sender' } }
      }
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
