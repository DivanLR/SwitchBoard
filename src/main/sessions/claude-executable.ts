// Resolves the Agent SDK's bundled standalone Claude executable.
//
// Under Electron the SDK's default launch path spawns a JavaScript runtime
// (which resolves to the Electron binary) and crashes on startup with a V8
// snapshot assertion. Spawning the self-contained platform executable directly
// avoids that entirely, so we pass its path as `pathToClaudeCodeExecutable`.
//
// When packaged, the executable lives under `app.asar.unpacked` (a file inside
// the asar archive cannot be executed), so any resolved asar path is rewritten.
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

/**
 * The user's own Claude Code CLI installed by the official native installer
 * (`~/.local/bin/claude`). It is a standalone binary (so spawning it is
 * crash-safe under Electron) and it auto-updates, so preferring it keeps the
 * authentication protocol current over time rather than pinning to the bundled
 * copy. Both read the same subscription credential, so auth is identical.
 */
function installedClaudeCli(): string | null {
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude'
  const candidate = join(homedir(), '.local', 'bin', exe)
  return existsSync(candidate) ? candidate : null
}

/** Rewrite an asar-internal path to its unpacked counterpart (spawnable on disk). */
export function toUnpacked(p: string): string {
  if (p.includes('app.asar.unpacked')) return p
  return p.replace(/app\.asar([\\/])/g, 'app.asar.unpacked$1')
}

let cached: string | null | undefined

export function resolveClaudeExecutable(): string | null {
  if (cached !== undefined) return cached

  // Prefer the user's auto-updating native install; fall back to the bundled copy.
  const installed = installedClaudeCli()
  if (installed) {
    cached = installed
    return cached
  }

  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude'
  const platformPkg = `claude-agent-sdk-${process.platform}-${process.arch}`
  const candidates: string[] = []

  try {
    const sdkDir = dirname(require.resolve('@anthropic-ai/claude-agent-sdk/package.json'))
    candidates.push(join(dirname(sdkDir), platformPkg, exe))
  } catch {
    // package.json may not be exported; try other strategies.
  }
  try {
    candidates.push(require.resolve(`@anthropic-ai/${platformPkg}/${exe}`))
  } catch {
    // platform package subpath not resolvable; try the packaged layout.
  }
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (resourcesPath) {
    candidates.push(
      join(resourcesPath, 'app.asar.unpacked', 'node_modules', '@anthropic-ai', platformPkg, exe),
    )
  }

  for (const candidate of candidates) {
    const unpacked = toUnpacked(candidate)
    if (existsSync(unpacked)) {
      cached = unpacked
      return cached
    }
    if (existsSync(candidate)) {
      cached = candidate
      return cached
    }
  }

  // Fall back to the SDK's own resolution; it works outside Electron.
  cached = null
  return cached
}
