// Command names arrive from the CLI's own system frames (init / commands_changed)
// and may carry the padding it uses for its own column layout. emitCommands
// trims that off before dedupe/sort/storage — otherwise a chosen suggestion
// would land in the composer with trailing whitespace ready to be sent as part
// of the slash command. See emitCommands in session.ts.
import { describe, expect, it } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ProjectCommand } from '@shared/domain'
import { HostedSession } from '@main/sessions/session'

// No live SDK query is ever created here: emitCommands and its only caller,
// captureInitCommands, are driven entirely off handleMessage, which start()
// would otherwise gate behind a real `query()` call (see session-model-refresh
// .spec.ts for the same construct-without-start() pattern).
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
  return { commandCalls, feed }
}

/** A 'commands_changed' system frame — the direct route into emitCommands,
 *  carrying name/description objects the way the CLI reports them mid-session. */
const commandsChanged = (commands: { name?: string; description?: string }[]): unknown => ({
  type: 'system',
  subtype: 'commands_changed',
  commands,
})

describe('emitCommands trims CLI column padding off command names', () => {
  it('trims a padded name before it reaches the composer list', () => {
    const { commandCalls, feed } = makeSession()
    feed(commandsChanged([{ name: '  ponytail  ' }]))
    expect(commandCalls.at(-1)).toEqual([{ name: 'ponytail' }])
  })

  it('dedupes two names that differ only by padding into one entry', () => {
    const { commandCalls, feed } = makeSession()
    feed(commandsChanged([{ name: 'ponytail  ' }, { name: '  ponytail' }]))
    expect(commandCalls.at(-1)?.map((c) => c.name)).toEqual(['ponytail'])
  })

  it('sorts by the trimmed name, not the padded one', () => {
    const { commandCalls, feed } = makeSession()
    // A leading space sorts ahead of every letter, so padding left untrimmed
    // would put " zebra" before "apple" — trimming has to happen before the sort.
    feed(commandsChanged([{ name: ' zebra' }, { name: 'apple' }]))
    expect(commandCalls.at(-1)?.map((c) => c.name)).toEqual(['apple', 'zebra'])
  })

  it('drops a whitespace-only or missing name instead of storing a blank command', () => {
    const { commandCalls, feed } = makeSession()
    feed(commandsChanged([{ name: '   ' }, { name: '' }, {}, { name: 'ponytail' }]))
    // Only the real command survives; the blank/absent ones never reach onCommands.
    expect(commandCalls.at(-1)).toEqual([{ name: 'ponytail' }])
  })

  it('never calls onCommands when every name in the batch is blank', () => {
    const { commandCalls, feed } = makeSession()
    feed(commandsChanged([{ name: '   ' }, { name: '' }]))
    expect(commandCalls).toEqual([])
  })
})
