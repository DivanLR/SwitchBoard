import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import {
  apiVerdict,
  checkCall,
  type ApiCall,
  type ApiRequestPlan,
} from '@shared/api-endpoints'
import type { Repositories } from '@main/store/repositories'
import { resolveApiHost, type ApiHost } from './api-scan'

const READY_TIMEOUT_MS = 90_000
const READY_POLL_MS = 1_000
const CALL_TIMEOUT_MS = 20_000
const BODY_LIMIT = 2_000

interface ApiRunOutcome {
  calls: ApiCall[]
  launched: boolean
  note: string | null
}

export async function runApiCalls(
  host: ApiHost,
  requests: readonly ApiRequestPlan[],
): Promise<ApiRunOutcome> {
  if (requests.length === 0) {
    return {
      calls: [],
      launched: false,
      note: 'No request data was produced, so nothing was called — open the session to see why.',
    }
  }

  const alreadyUp = await reachable(host.baseUrl)
  let child: ChildProcess | null = null
  let startupLog = ''

  if (!alreadyUp) {
    if (!host.startCmd) {
      const reason =
        host.target === 'qa'
          ? `${host.baseUrl} did not answer, so nothing was called`
          : `nothing is listening on ${host.baseUrl} and no start command is set`
      return {
        calls: notRun(requests, reason),
        launched: false,
        note:
          host.target === 'qa'
            ? `${host.baseUrl} did not answer. Check the URL, the network and whether that environment is up — nothing was started for you, and nothing should be.`
            : `Nothing is listening on ${host.baseUrl}. Start the API, or set a start command for this project.`,
      }
    }
    child = spawn(host.startCmd, {
      cwd: host.cwd,
      shell: true,
      windowsHide: true,
      env: { ...process.env, ASPNETCORE_URLS: host.baseUrl, DOTNET_ENVIRONMENT: 'Development' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const collect = (chunk: Buffer): void => {
      startupLog = `${startupLog}${chunk.toString()}`.slice(-4_000)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)

    const up = await waitForServer(host.baseUrl, child)
    if (!up) {
      stop(child)
      const reason = lastLine(startupLog)
      return {
        calls: notRun(requests, 'the API never started listening'),
        launched: true,
        note:
          `The API did not start listening on ${host.baseUrl} within ${READY_TIMEOUT_MS / 1000}s ` +
          `(${host.startCmd})${reason ? `. Last output: ${reason}` : '.'}`,
      }
    }
  }

  try {
    const calls: ApiCall[] = []
    for (const request of requests) {
      calls.push(blockedWrite(host, request) ?? (await sendOne(host, request)))
    }
    const blocked = calls.filter((c) => c.detail === WRITE_BLOCKED).length
    return {
      calls,
      launched: child !== null,
      note:
        blocked > 0
          ? `${blocked} write ${blocked === 1 ? 'request was' : 'requests were'} not sent: this run ` +
            'targets a shared QA environment, where the eval set exercises reads only.'
          : null,
    }
  } finally {
    if (child) stop(child)
  }
}

const WRITE_BLOCKED =
  'not sent: a write against a shared QA environment is blocked, so the eval set exercises reads only'

function notRunCall(request: ApiRequestPlan, detail: string): ApiCall {
  return { request, status: null, ms: null, body: null, outcome: 'not_run', detail }
}

function blockedWrite(host: ApiHost, request: ApiRequestPlan): ApiCall | null {
  if (host.target !== 'qa' || request.method === 'GET' || request.method === 'HEAD') return null
  return notRunCall(request, WRITE_BLOCKED)
}

async function sendOne(host: ApiHost, request: ApiRequestPlan): Promise<ApiCall> {
  const url = `${host.baseUrl.replace(/\/+$/, '')}${request.path.startsWith('/') ? '' : '/'}${request.path}`
  const started = Date.now()
  try {
    const response = await fetch(url, {
      method: request.method,
      headers: {
        ...(request.body ? { 'content-type': 'application/json' } : {}),
        ...(host.headers ?? {}),
        ...(request.headers ?? {}),
      },
      body: request.body ?? undefined,
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      redirect: 'manual',
    })
    const ms = Date.now() - started
    const full = await response.text().catch(() => '')
    const { outcome, detail } = checkCall(request.expect, response.status, full)
    return {
      request,
      status: response.status,
      ms,
      body: full.slice(0, BODY_LIMIT),
      outcome,
      detail,
    }
  } catch (error) {
    return notRunCall(request, `the call did not complete: ${message(error)}`)
  }
}

function notRun(requests: readonly ApiRequestPlan[], reason: string): ApiCall[] {
  return requests.map((request) => notRunCall(request, reason))
}

async function reachable(baseUrl: string): Promise<boolean> {
  try {
    await fetch(baseUrl, { signal: AbortSignal.timeout(2_000), redirect: 'manual' })
    return true
  } catch {
    return false
  }
}

async function waitForServer(baseUrl: string, child: ChildProcess): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  let dead = false
  child.once('exit', () => {
    dead = true
  })
  while (Date.now() < deadline) {
    if (await reachable(baseUrl)) return true
    if (dead) return false
    await delay(READY_POLL_MS)
  }
  return false
}

function stop(child: ChildProcess): void {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
    return
  }
  try {
    child.kill('SIGTERM')
  } catch {
  }
}

function lastLine(log: string): string | null {
  const lines = log
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  return lines.length > 0 ? lines[lines.length - 1].slice(0, 300) : null
}

function message(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export async function completeApiRun(deps: {
  repos: Repositories
  projectId: string
  runId: string
  requests: readonly ApiRequestPlan[]
  changed: (projectId: string) => void
}): Promise<void> {
  const { repos, projectId, runId, requests, changed } = deps
  const run = repos.apiRuns.byId(runId)
  if (!run || run.status !== 'running') return
  try {
    const project = repos.projects.byId(projectId)
    if (!project) throw new Error('the project is no longer registered')
    const settings = repos.settings.get()
    const host = await resolveApiHost(project.path, {
      target: run.target,
      baseUrl: run.baseUrl,
      qaBaseUrl: run.baseUrl,
      qaHeaders: settings.projectApiQaHeaders[projectId],
      startCmd: settings.projectApiStart[projectId],
    })
    if ('error' in host) throw new Error(host.error)
    const outcome = await runApiCalls(host, requests)
    repos.apiRuns.finish(
      runId,
      apiVerdict(outcome.calls),
      outcome.calls,
      outcome.note,
      outcome.launched,
    )
  } catch (error) {
    repos.apiRuns.finish(runId, 'error', [], `The run could not be completed: ${message(error)}`, false)
  }
  changed(projectId)
}
