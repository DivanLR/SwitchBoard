// Two independent sources report a session's commands at boot: the
// supportedCommands() control request, and the 'init' system frame's
// slash_commands + skills. Both funnel into emitCommands, and every call writes
// through to a repository row that is overwritten whole — so a source that
// rebuilt the list from its own batch alone erased whatever the other had just
// reported, and whichever resolved last won.
//
// The symptom was not subtle and did not look like a bug in this file: a plugin
// shipping six skills and one command showed exactly one row as runnable, and
// the other five read "Not available" in the Cleanup section while being
// installed the whole time. See emitCommands in session.ts.
import { describe, expect, it } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ProjectCommand } from '@shared/domain'
import { HostedSession } from '@main/sessions/session'

// Constructed, never started: emitCommands is reached through handleMessage and
// through the private method directly, neither of which needs a live query().
// Same pattern as command-trim.spec.ts and session-model-refresh.spec.ts.
function makeSession() {
  const commandCalls: ProjectCommand[][] = []
  const sink = { append: (): never => ({}) as never, update: (): void => {} }
  const session = new HostedSession({
    sessionId: 's1',
    mode: 'default',
    projectPath: '.',
    sink: sink as never,
    gate: (async () => ({ behavior: 'allow', updatedInput: {} })) as never,
    onStatusChange: () => {},
    onSdkSessionId: () => {},
    onTurnComplete: () => {},
    onExit: () => {},
    onCommands: (commands) => commandCalls.push(commands),
  })
  const feed = (m: unknown): void =>
    (session as unknown as { handleMessage(m: SDKMessage): void }).handleMessage(m as SDKMessage)
  /** The supportedCommands() control request resolving, which start() wires up. */
  const supported = (commands: ProjectCommand[]): void =>
    (session as unknown as { emitCommands(c: ProjectCommand[], replace?: boolean): void }).emitCommands(
      commands,
    )
  const names = (): string[] => (commandCalls.at(-1) ?? []).map((c) => c.name)
  return { commandCalls, feed, supported, names }
}

/** The 'init' frame, which carries bare NAMES only, no descriptions. */
const init = (slashCommands: string[], skills: string[] = []): unknown => ({
  type: 'system',
  subtype: 'init',
  slash_commands: slashCommands,
  skills,
})

const commandsChanged = (commands: { name?: string; description?: string }[]): unknown => ({
  type: 'system',
  subtype: 'commands_changed',
  commands,
})

describe('a session merges what both boot sources report', () => {
  it('keeps the skills from init when supportedCommands answers afterwards', () => {
    const { feed, supported, names } = makeSession()
    feed(
      init(
        [],
        [
          'dotnet-claude-kit:de-sloppify',
          'dotnet-claude-kit:security-scan',
          'dotnet-claude-kit:verify',
          'dotnet-claude-kit:health-check',
          'dotnet-claude-kit:migrate',
        ],
      ),
    )
    supported([{ name: 'dotnet-claude-kit:code-review', description: 'Blast-radius review' }])

    // All six, not just the one the later source happened to carry.
    expect(names()).toEqual([
      'dotnet-claude-kit:code-review',
      'dotnet-claude-kit:de-sloppify',
      'dotnet-claude-kit:health-check',
      'dotnet-claude-kit:migrate',
      'dotnet-claude-kit:security-scan',
      'dotnet-claude-kit:verify',
    ])
  })

  it('keeps them in the other order too, because neither source is the authority', () => {
    const { feed, supported, names } = makeSession()
    supported([{ name: 'dotnet-claude-kit:code-review', description: 'Blast-radius review' }])
    feed(init([], ['dotnet-claude-kit:de-sloppify', 'dotnet-claude-kit:verify']))

    expect(names()).toEqual([
      'dotnet-claude-kit:code-review',
      'dotnet-claude-kit:de-sloppify',
      'dotnet-claude-kit:verify',
    ])
  })

  it('does not lose a description when a later source reports the same name bare', () => {
    const { feed, supported, commandCalls } = makeSession()
    supported([{ name: 'code-review', description: 'Blast-radius review' }])
    feed(init(['code-review']))

    expect(commandCalls.at(-1)).toEqual([{ name: 'code-review', description: 'Blast-radius review' }])
  })

  // The one case that must still drop names: a plugin genuinely removed a
  // command, and the CLI's own contract for this frame is that the client
  // replaces its cached list. Without this, an uninstall could never be seen.
  it('replaces the whole set on commands_changed, so a removal takes effect', () => {
    const { feed, supported, names } = makeSession()
    supported([{ name: 'old-one' }, { name: 'kept' }])
    feed(init(['from-init']))
    expect(names()).toContain('old-one')

    feed(commandsChanged([{ name: 'kept' }]))
    expect(names()).toEqual(['kept'])
  })
})
