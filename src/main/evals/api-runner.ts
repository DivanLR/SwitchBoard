// The automated part of an API run: the app starts the API if it is not already
// up, sends every planned request itself, and judges each answer in code.
//
// Nothing here asks a model anything. The status is the one the socket returned,
// the timing is measured, and the verdict comes from checkCall() — so a green
// eval set means the endpoints answered, not that something reported they did.
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import {
  apiVerdict,
  checkCall,
  type ApiCall,
  type ApiRequestPlan,
} from '@shared/api-endpoints'
import type { Repositories } from '@main/store/repositories'
import { resolveApiHost, type ApiHost } from './api-scan'

/** How long a server gets to start listening before the run gives up. */
const READY_TIMEOUT_MS = 90_000
const READY_POLL_MS = 1_000
/** Per-call ceiling: a hung endpoint fails its own call, never the whole run. */
const CALL_TIMEOUT_MS = 20_000
/** Response bodies are evidence, not archives. */
const BODY_LIMIT = 2_000

export interface ApiRunOutcome {
  calls: ApiCall[]
  /** True when this run started the server and stopped it again. */
  launched: boolean
  /** Set when the run could not do what it was asked, in one sentence. */
  note: string | null
}

/**
 * Send every request and judge every answer.
 *
 * An API that is already running is used as it is and left running: reclaiming a
 * port the developer is using themselves would be the app breaking their session
 * to test it. Only a server this function started is a server this function kills.
 */
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
      // A deployed environment that does not answer is news about the environment,
      // not a missing setting, so it is not reported as one.
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
      // The resolved URL is forced on the server so the port it binds is the port
      // this run calls, rather than whichever profile the tooling picks.
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

/**
 * A write the run refuses to send against a deployed environment.
 *
 * The prompt asks the session to plan reads only for QA, and that is the right
 * place to ask — but a request is only ever a request. The panel tells the
 * developer that a QA run is "reads only", and a promise about what this app does
 * to someone else's environment has to be kept by the code that opens the socket,
 * not by the model that proposed the plan. One mis-planned DELETE against a shared
 * environment is not a test result, it is an incident, and prose cannot prevent it.
 *
 * Reported as 'not_run' rather than 'fail', because the endpoint was never asked:
 * nothing here says anything about whether that write works.
 */
function blockedWrite(host: ApiHost, request: ApiRequestPlan): ApiCall | null {
  if (host.target !== 'qa' || request.method === 'GET' || request.method === 'HEAD') return null
  return {
    request,
    status: null,
    ms: null,
    body: null,
    outcome: 'not_run',
    detail: WRITE_BLOCKED,
  }
}

/** One request: sent, timed, and judged. */
async function sendOne(host: ApiHost, request: ApiRequestPlan): Promise<ApiCall> {
  const url = `${host.baseUrl.replace(/\/+$/, '')}${request.path.startsWith('/') ? '' : '/'}${request.path}`
  const started = Date.now()
  try {
    const response = await fetch(url, {
      method: request.method,
      headers: {
        ...(request.body ? { 'content-type': 'application/json' } : {}),
        // The environment's own headers first, the request's second, so a request
        // can still drop or blank the API key on purpose — the "absent auth should
        // be 401" case is one the eval set is asked for, and a project header that
        // always won would make it impossible to write.
        ...(host.headers ?? {}),
        ...(request.headers ?? {}),
      },
      body: request.body ?? undefined,
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      redirect: 'manual',
    })
    const ms = Date.now() - started
    // Judged on the WHOLE body, stored truncated. Checking the truncated copy made
    // the verdict depend on the response's length: a correct JSON array longer than
    // BODY_LIMIT no longer parsed, so checkCall reported "the body is not an array"
    // and a working endpoint failed for having a lot to say.
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
    // A call that never completed is 'not_run', never 'fail': a socket that
    // refused or timed out says nothing about whether the endpoint is correct.
    return {
      request,
      status: null,
      ms: null,
      body: null,
      outcome: 'not_run',
      detail: `the call did not complete: ${message(error)}`,
    }
  }
}

function notRun(requests: readonly ApiRequestPlan[], reason: string): ApiCall[] {
  return requests.map((request) => ({
    request,
    status: null,
    ms: null,
    body: null,
    outcome: 'not_run' as const,
    detail: reason,
  }))
}

/** Any HTTP answer at all proves a server is listening — a 404 counts. */
async function reachable(baseUrl: string): Promise<boolean> {
  try {
    await fetch(baseUrl, { signal: AbortSignal.timeout(2_000), redirect: 'manual' })
    return true
  } catch {
    return false
  }
}

/** Poll until the server answers, the process dies, or the timeout expires. */
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Kill the server and everything it started.
 *
 * `dotnet run` is a launcher: killing it alone leaves the actual web host holding
 * the port, so the next run finds something listening that is not the code under
 * test. taskkill /T is what reaches the whole tree on Windows.
 */
function stop(child: ChildProcess): void {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
    return
  }
  try {
    child.kill('SIGTERM')
  } catch {
    // Already gone.
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

/**
 * The second half of an API run: the session has produced the request data, so
 * now the app sends it and records what came back.
 *
 * Called from the session-manager callback rather than the IPC handler, because
 * the request data arrives asynchronously in the session's own output. A run is
 * always finished, including when this throws: a row left as running would show
 * a spinner forever with nothing behind it.
 */
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
    const host = resolveApiHost(project.path, {
      // The run's own base URL and target win: they are what the developer was
      // told the calls would go to when they started it, and re-deciding the
      // environment now would let an edited setting move a run mid-flight.
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
