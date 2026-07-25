// Resolves the Claude Code executable the app drives.
//
// Under Electron the SDK's default launch path spawns a JavaScript runtime
// (which resolves to the Electron binary) and crashes on startup with a V8
// snapshot assertion. Spawning a self-contained platform executable directly
// avoids that entirely, so we pass its path as `pathToClaudeCodeExecutable`.
//
// That executable is the user's OWN install from the official native installer
// (`~/.local/bin/claude`): a standalone binary, so spawning it is crash-safe
// under Electron, and it auto-updates, so the authentication protocol and the
// model list stay current. The Agent SDK's bundled copy is deliberately NOT a
// fallback — electron-builder excludes it from the package (~245 MB per
// platform, see electron-builder.yml), so it could never be resolved in a
// packaged build. startSession reports a clear install message when absent.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function resolveClaudeExecutable(): string | null {
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude'
  const candidate = join(homedir(), '.local', 'bin', exe)
  return existsSync(candidate) ? candidate : null
}
