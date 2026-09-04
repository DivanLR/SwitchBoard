// The one thing an agent in this app cannot otherwise do: hand work to ANOTHER
// project's session.
//
// Everything else the "one lead, many project leads, many ICs" shape needs was
// already here — a session per project, subagents inside it, a planned-task
// queue that drains when the session goes idle — and none of it could be reached
// from inside a conversation. This exposes exactly one tool to close that gap.
//
// Delivery is the EXISTING planned-task queue rather than a channel of its own,
// which is what keeps this small and honest: a message to a busy project waits
// instead of being dropped, a message to a project with no session survives
// until one starts, and every handover shows up in the queue the developer can
// already read, reword or delete. A private inbox would have needed a table, a
// migration, an IPC surface and a view before it did anything the queue does.
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import type { SessionStatus } from '@shared/domain'
import { z } from 'zod'

export interface InterSessionDeps {
  /** The sending project's name — the receiving session is told who asked. */
  from: string
  /** Every project the app knows, re-read per call: a project can be added,
   *  renamed or archived while a long-running session holds this tool. */
  projects: () => { id: string; name: string }[]
  /** Delivery, which is SessionManager.enqueueTask (see the header). */
  enqueue: (projectId: string, text: string) => void
  /** SessionManager.liveEntryForProject, as a yes/no. */
  isRunning: (projectId: string) => boolean
  /** SessionManager.startSession. Rejects the way that does (Docker down, the
   *  container cap, no Claude Code binary), and handoff reports the reason
   *  rather than letting a handover look delivered when nothing will run it. */
  start: (projectId: string) => Promise<unknown>
  /** One row per project for the `sessions` tool: is a session live, what is it
   *  doing, and how much is waiting in its queue. */
  overview: () => {
    name: string
    running: boolean
    status?: SessionStatus
    queued: number
  }[]
}

/**
 * Resolve a target project and deliver, or say why not. Separate from the tool
 * definition so it can be tested without standing an MCP server up: this
 * function is the whole of the behaviour, and `tool()` below only dresses its
 * answer in MCP's content shape.
 */
export async function handoff(
  deps: InterSessionDeps,
  to: string,
  message: string,
): Promise<{ ok: boolean; text: string }> {
  const projects = deps.projects()
  const wanted = to.trim().toLowerCase()
  // Exact (case-insensitive) only, deliberately: a fuzzy match that picks the
  // wrong project sends real work to the wrong codebase, whereas a miss costs
  // one turn and returns the list to choose from.
  const match = projects.find((p) => p.name.toLowerCase() === wanted)
  if (!match) {
    const names = projects.map((p) => p.name).join(', ')
    return {
      ok: false,
      text: `No project is called "${to}". The projects open in this window are: ${names || 'none'}.`,
    }
  }
  // A session that can queue work for itself can queue work for itself forever:
  // the task runs, the run queues another, and nothing outside the loop ever
  // gets a turn. Refused rather than deduplicated, because there is no
  // legitimate use for it — a session that wants to keep working keeps working.
  if (match.name === deps.from) {
    return {
      ok: false,
      text: "That is this session's own project. Carry on with the work here instead of queueing it.",
    }
  }
  deps.enqueue(match.id, `Handed over by the ${deps.from} session:\n\n${message}`)
  // Queue FIRST, then start: a session drains the queue as soon as it comes up
  // idle (see maybeDrainQueue), so this order runs the work without a second
  // delivery step, and a start that fails still leaves the handover waiting.
  if (deps.isRunning(match.id)) {
    return {
      ok: true,
      text: `Queued for ${match.name}, which already has a session running. It runs when that session is next idle; nothing comes back here.`,
    }
  }
  // "It survives until a session starts" was true and useless: nobody was going
  // to start one, so a handover to an idle project sat in a queue the sender
  // could not see and the developer had no reason to look at. Starting it is the
  // whole difference between delegating work and filing it.
  try {
    await deps.start(match.id)
    return {
      ok: true,
      text: `Started a session for ${match.name} and queued the work; it runs as soon as that session is idle. Nothing comes back here — call \`sessions\` to see it running.`,
    }
  } catch (e) {
    const why = e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e)
    return {
      ok: true,
      text: `Queued for ${match.name}, but starting a session for it failed: ${why}. The handover waits in that project's queue until a session starts.`,
    }
  }
}

/** The `sessions` answer as one block of text: a line per project, the sender's
 *  own marked, so a handover can be reported with what is actually running
 *  rather than "it is in a queue somewhere I cannot see". */
export function sessionsReport(deps: InterSessionDeps): string {
  const rows = deps.overview()
  if (rows.length === 0) return 'No projects are open in this Switchboard window.'
  const say = (r: (typeof rows)[number]): string => {
    const who = r.name === deps.from ? `${r.name} (this session)` : r.name
    const state = r.running ? (r.status ?? 'running') : 'no session running'
    const queue = r.queued === 0 ? '' : `, ${r.queued} queued`
    return `- ${who}: ${state}${queue}`
  }
  return [`${rows.filter((r) => r.running).length} of ${rows.length} projects have a session running.`, ...rows.map(say)].join(
    '\n',
  )
}

/**
 * One in-process MCP server, two tools: `mcp__switchboard__send` and
 * `mcp__switchboard__sessions`.
 *
 * `alwaysLoad` because a tool behind tool search is a tool the model does not
 * know it has — and the whole point of these is that a session reaches for them
 * unprompted when the work belongs to another project.
 */
export function switchboardMcp(deps: InterSessionDeps): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: 'switchboard',
    version: '1.0.0',
    tools: [
      tool(
        'send',
        'Hand work to another project open in this Switchboard window. The message joins the ' +
          "back of that project's planned-task queue, and the project's session is STARTED if " +
          'it does not have one, so the work runs rather than waiting for someone to notice it. ' +
          'Safe whether the other project is busy or idle. Fire and forget: there is no reply, ' +
          'and no way to wait for one. Use it to delegate work that belongs to another codebase, ' +
          'or to report something you found that its session needs to know. Report what came ' +
          'back to the developer, and call `sessions` afterwards so they can see it running.',
        {
          to: z
            .string()
            .describe('The project name exactly as it appears in the Switchboard sidebar.'),
          message: z
            .string()
            .describe(
              'The instruction to hand over. Must stand alone: the receiving session cannot ' +
                'see this conversation, its files or its findings.',
            ),
        },
        async ({ to, message }) => {
          const result = await handoff(deps, to, message)
          return {
            isError: result.ok ? undefined : true,
            content: [{ type: 'text' as const, text: result.text }],
          }
        },
        { alwaysLoad: true },
      ),
      tool(
        'sessions',
        'List every project open in this Switchboard window: whether it has a session running, ' +
          'what that session is doing, and how many tasks are queued for it. Read-only. Call it ' +
          'before handing work over to pick the right target, and after handing over so the ' +
          'developer can see the receiving session is actually running.',
        {},
        async () => ({ content: [{ type: 'text' as const, text: sessionsReport(deps) }] }),
        { alwaysLoad: true },
      ),
    ],
  })
}
