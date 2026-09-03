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
import { z } from 'zod'

export interface InterSessionDeps {
  /** The sending project's name — the receiving session is told who asked. */
  from: string
  /** Every project the app knows, re-read per call: a project can be added,
   *  renamed or archived while a long-running session holds this tool. */
  projects: () => { id: string; name: string }[]
  /** Delivery, which is SessionManager.enqueueTask (see the header). */
  enqueue: (projectId: string, text: string) => void
}

/**
 * Resolve a target project and deliver, or say why not. Separate from the tool
 * definition so it can be tested without standing an MCP server up: this
 * function is the whole of the behaviour, and `tool()` below only dresses its
 * answer in MCP's content shape.
 */
export function handoff(
  deps: InterSessionDeps,
  to: string,
  message: string,
): { ok: boolean; text: string } {
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
  return {
    ok: true,
    text: `Queued for ${match.name}. It runs when that project's session is next idle; nothing comes back here.`,
  }
}

/**
 * One in-process MCP server, one tool: `mcp__switchboard__send`.
 *
 * `alwaysLoad` because a tool behind tool search is a tool the model does not
 * know it has — and the whole point of this one is that a session reaches for it
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
          "back of that project's planned-task queue and is delivered to its session as soon as " +
          'that session is idle, so calling this is safe whether the other project is busy, or ' +
          'has no session running at all. Fire and forget: there is no reply, and no way to ' +
          'wait for one. Use it to delegate work that belongs to another codebase, or to report ' +
          'something you found that its session needs to know.',
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
          const result = handoff(deps, to, message)
          return {
            isError: result.ok ? undefined : true,
            content: [{ type: 'text' as const, text: result.text }],
          }
        },
        { alwaysLoad: true },
      ),
    ],
  })
}
