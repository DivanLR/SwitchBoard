import { describe, expect, it } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ProjectCommand } from '@shared/domain'
import { HostedSession } from '@main/sessions/session'

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
  const supported = (commands: ProjectCommand[]): void =>
    (session as unknown as { emitCommands(c: ProjectCommand[], replace?: boolean): void }).emitCommands(
      commands,
    )
  const names = (): string[] => (commandCalls.at(-1) ?? []).map((c) => c.name)
  return { commandCalls, feed, supported, names }
}

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

  it('replaces the whole set on commands_changed, so a removal takes effect', () => {
    const { feed, supported, names } = makeSession()
    supported([{ name: 'old-one' }, { name: 'kept' }])
    feed(init(['from-init']))
    expect(names()).toContain('old-one')

    feed(commandsChanged([{ name: 'kept' }]))
    expect(names()).toEqual(['kept'])
  })
})
