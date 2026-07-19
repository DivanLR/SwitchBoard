// Diagnostic: run one Agent SDK turn inside the real Electron runtime.
// Tests whether pointing pathToClaudeCodeExecutable at the bundled standalone
// claude executable avoids the Electron snapshot crash.
// Run: npx electron scripts/electron-session-probe.mjs
import { app } from 'electron'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

process.on('uncaughtException', (e) => {
  console.error('UNCAUGHT_EXCEPTION', e && e.stack ? e.stack : e)
  app.exit(2)
})
process.on('unhandledRejection', (e) => {
  console.error('UNHANDLED_REJECTION', e && e.stack ? e.stack : e)
  app.exit(3)
})

function resolveClaudeExecutable() {
  const require = createRequire(import.meta.url)
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude'
  const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
  try {
    const sdkDir = dirname(require.resolve('@anthropic-ai/claude-agent-sdk/package.json'))
    const candidate = join(dirname(sdkDir), `claude-agent-sdk-${process.platform}-${process.arch}`, exe)
    if (existsSync(candidate)) return candidate
  } catch {
    // fall through
  }
  try {
    const p = require.resolve(`${pkg}/${exe}`)
    if (existsSync(p)) return p
  } catch {
    // fall through
  }
  return null
}

app.whenReady().then(async () => {
  const claudeExe = resolveClaudeExecutable()
  console.log('ELECTRON', process.versions.electron, 'claudeExe', claudeExe)
  try {
    const q = query({
      prompt: 'Reply with the single word OK and nothing else.',
      options: {
        cwd: process.cwd(),
        includePartialMessages: true,
        pathToClaudeCodeExecutable: claudeExe ?? undefined,
        // Mirror the app's option set: terse-mode system-prompt append.
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: 'OUTPUT STYLE (terse). Be maximally concise. Preserve code and errors exactly.',
        },
      },
    })
    for await (const m of q) {
      console.log('MSG', m.type, m.subtype ?? '')
      if (m.type === 'result') {
        console.log('RESULT', m.subtype, 'cost', m.total_cost_usd)
        break
      }
    }
    console.log('PROBE_OK')
    app.exit(0)
  } catch (e) {
    console.error('PROBE_ERR', e && e.stack ? e.stack : e)
    app.exit(1)
  }
})
