import { clipboard, dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import type { Project, Session, SessionEvent } from '@shared/domain'
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
import { isSafeSegment } from '@shared/skill-source'
import { auditPrompt, SECURITY_SKILL_NAME } from '@main/security/audit-dispatch'
import type { FlowSupervisor } from '@main/flow/flow-supervisor'
import { disableSkill, enableSkill, removeSkill } from '@main/skills/install'
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
  securityRoot: string
  flow: FlowSupervisor
  broker: PermissionBroker
  getWindow: () => BrowserWindow | null
  dbProjectId: string
  ptyHost: PtyHost
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
        }
      }),
  )
  return listing
}

const ALLOWED_PLUGINS: ReadonlySet<string> = new Set([
  ...CLEANUP_GROUPS.map((group) => `${group.marketplace}|${group.pkg}`),
  `${DIAGRAM_PLUGIN.marketplace}|${DIAGRAM_PLUGIN.pkg}`,
])

export function registerIpcHandlers(deps: HandlerDeps): void {
  const { repos, manager, broker, dbProjectId, skillsStagingRoot, securityRoot, ptyHost, flow } = deps

  const requireProject = (projectId: string): Project => {
    const project = repos.projects.byId(projectId)
    if (!project) throw { code: 'NOT_FOUND', message: 'Project not found' } satisfies IpcError
    return project
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
        apiRunSessionIds: repos.apiRuns
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
      manager.startSession(req.projectId, req.resume ?? false, req.mode, req.carryTranscriptFrom, {
        containerised: req.containerised === true,
        engine: req.engine,
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
    'skills.list': () => repos.customSkills.list(),
    'skills.import': async (req) => {
      const result = await importSkills(req.url, skillsStagingRoot, repos.customSkills.names())
      repos.customSkills.insertMany(result.imported)
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
      return repos.customSkills.list()
    },
    'skills.remove': async (req) => {
      await removeSkill(skillsStagingRoot, req.name)
      repos.customSkills.remove(req.name)
      await manager.reloadPlugins()
      return repos.customSkills.list()
    },
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
    'mcp.scanHistory': (req) => repos.mcpScans.listForProject(req.projectId),
    'mcp.recordScan': async (req) => {
      const project = repos.projects.byId(req.projectId)
      if (!project) throw { code: 'NOT_FOUND', message: 'Project not found' } satisfies IpcError
      if (!req.servers.length) return null
      const docPath = comboDocPath(project.path, req.servers)
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
      if (req.watchDiagrams) manager.watchDiagram(session.id)
      manager.sendMessage(session.id, req.text)
      return { sessionId: session.id }
    },
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
    'evals.suites': async (req) => {
      const project = repos.projects.byId(req.projectId)
      if (!project) throw { code: 'NOT_FOUND', message: 'Project not found' } satisfies IpcError
      try {
        const listing = await preReadStackEntries(project.path)
        const entries = stackEntries(project.path, (dir) => {
          const found = listing.get(dir)
          if (found === undefined) throw new Error(`not listed: ${dir}`)
          return found
        })
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
            contents.set(entry, await readFile(join(project.path, entry), 'utf8').catch(() => null))
          }),
        )
        return detectStacks(entries, (entry) => contents.get(entry) ?? null)
      } catch {
        return []
      }
    },
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
      const session = await manager.backgroundSessionFor(req.projectId, 'tests')
      if (req.kind === 'check') repos.evals.update(req.id, { checkStatus: 'not_run' })
      if (req.kind === 'judge') repos.evals.update(req.id, { judge: null })
      if (req.kind !== 'attempts') manager.watchEvalMarker(session.id, req.id, req.kind)
      manager.sendMessage(session.id, text)
      return { sessionId: session.id, runs: repos.evals.listForProject(req.projectId) }
    },
    'verify.list': (req) => repos.verifyRuns.listForProject(req.projectId),
    'verify.start': async (req) => {
      const stack = stackById(req.stackId)
      if (!stack) throw { code: 'NOT_FOUND', message: 'Unknown stack.' } satisfies IpcError
      const session = req.isolated ? null : await manager.backgroundSessionFor(req.projectId, 'tests')
      const project = repos.projects.byId(req.projectId)
      const sandboxed =
        project && (req.isolated || session?.bypassPermissions === true)
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
          message: 'None of the chosen suites can run in the bypass container — end it, or pick node suites.',
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
        manager.sendMessage(session.id, verifyPrompt(plan, stack.label, sandboxed, dbServers))
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
    'flow.list': (req) => flowSnapshot(req.projectId),
    'flow.features': async (req) => {
      requireProject(req.projectId)
      return flow.features(req.projectId, req.query ?? '')
    },
    'flow.existingSpecs': async (req) => {
      requireProject(req.projectId)
      return flow.existingSpecs(req.projectId)
    },
    'flow.start': async (req) => {
      requireProject(req.projectId)
      const run = await flow.start({
        projectId: req.projectId,
        source: req.source,
        autopilot: req.autopilot,
        autoShip: req.autoShip,
        baseBranch: req.baseBranch,
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
    'flow.artefact': async (req) => flow.artefact(req.runId, req.stage, req.kind),
    'security.list': (req) => repos.securityRuns.listForProject(req.projectId),
    'security.start': async (req) => {
      const project = repos.projects.byId(req.projectId)
      if (!project) throw { code: 'NOT_FOUND', message: 'Project not found' } satisfies IpcError
      if (repos.securityRuns.runningFor(req.projectId)) {
        throw {
          code: 'RULE_NOT_ALLOWED',
          message: 'An audit is already running for this project. Wait for it, or stop it first.',
        } satisfies IpcError
      }
      if (!repos.customSkills.byName(SECURITY_SKILL_NAME)?.enabled) {
        throw {
          code: 'NOT_FOUND',
          message: 'Install the security-audit skill first, then run the audit.',
        } satisfies IpcError
      }
      const session = await manager.backgroundSessionFor(req.projectId, 'security')
      const outputDir = join(
        securityRoot,
        req.projectId,
        `run-${new Date().toISOString().replace(/[:.]/g, '-')}`,
      )
      await mkdir(outputDir, { recursive: true })
      const run = repos.securityRuns.start({
        projectId: req.projectId,
        sessionId: session.id,
        scope: req.scope,
        branch: session.branch ?? null,
        outputDir,
      })
      manager.watchSecurityRun(session.id, run.id, outputDir)
      manager.sendMessage(session.id, auditPrompt({ scope: req.scope, outputDir }))
      return { sessionId: session.id, runs: repos.securityRuns.listForProject(req.projectId) }
    },
    'security.cancel': async (req) => {
      await manager.cancelSecurityRun(req.runId)
      return repos.securityRuns.listForProject(req.projectId)
    },
    'security.openReport': async (req) => {
      const run = repos.securityRuns.byId(req.runId)
      if (!run || run.projectId !== req.projectId) {
        throw { code: 'NOT_FOUND', message: 'Run not found' } satisfies IpcError
      }
      if (!isSafeSegment(req.file) || !req.file.endsWith('.md')) {
        throw { code: 'INVALID_PATH', message: 'That is not a report file' } satisfies IpcError
      }
      const target = join(run.outputDir, req.file)
      if (!existsSync(target)) {
        throw { code: 'NOT_FOUND', message: 'That report is no longer on disk' } satisfies IpcError
      }
      await shell.openPath(target)
    },
    'api.cancel': async (req) => {
      await manager.cancelApiRun(req.runId)
      return repos.apiRuns.listForProject(req.projectId)
    },
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
      const host = await resolveApiHost(project.path, {
        target,
        baseUrl: settings.projectApiBase[req.projectId],
        startCmd: settings.projectApiStart[req.projectId],
        qaBaseUrl: settings.projectApiQa[req.projectId],
        qaHeaders: settings.projectApiQaHeaders[req.projectId],
      })
      if ('error' in host) throw { code: 'INVALID_PATH', message: host.error } satisfies IpcError
      const session = await manager.backgroundSessionFor(req.projectId, 'tests')
      const run = repos.apiRuns.start({
        projectId: req.projectId,
        baseUrl: host.baseUrl,
        target: host.target,
        sessionId: session.id,
      })
      manager.watchApiRequests(session.id, run.id)
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
