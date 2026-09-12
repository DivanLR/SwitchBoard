import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import type { SessionStatus } from '@shared/domain'
import { z } from 'zod'

export interface InterSessionDeps {
  from: string
  projects: () => { id: string; name: string }[]
  enqueue: (projectId: string, text: string) => void
  isRunning: (projectId: string) => boolean
  start: (projectId: string) => Promise<unknown>
  overview: () => {
    name: string
    running: boolean
    status?: SessionStatus
    queued: number
  }[]
}

export async function handoff(
  deps: InterSessionDeps,
  to: string,
  message: string,
): Promise<{ ok: boolean; text: string }> {
  const projects = deps.projects()
  const wanted = to.trim().toLowerCase()
  const match = projects.find((p) => p.name.toLowerCase() === wanted)
  if (!match) {
    const names = projects.map((p) => p.name).join(', ')
    return {
      ok: false,
      text: `No project is called "${to}". The projects open in this window are: ${names || 'none'}.`,
    }
  }
  if (match.name === deps.from) {
    return {
      ok: false,
      text: "That is this session's own project. Carry on with the work here instead of queueing it.",
    }
  }
  deps.enqueue(match.id, `Handed over by the ${deps.from} session:\n\n${message}`)
  if (deps.isRunning(match.id)) {
    return {
      ok: true,
      text: `Queued for ${match.name}, which already has a session running. It runs when that session is next idle; nothing comes back here.`,
    }
  }
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
