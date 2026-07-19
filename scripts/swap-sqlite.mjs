// Swaps the better-sqlite3 native binary between the Node ABI (Vitest, CLI
// tools) and the Electron ABI (the running application) using prebuilt
// binaries, so neither flow requires a local C++ toolchain.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const target = process.argv[2]

if (target !== 'electron' && target !== 'node') {
  console.error('Usage: node scripts/swap-sqlite.mjs <electron|node>')
  process.exit(1)
}

const pkgDir = dirname(require.resolve('better-sqlite3/package.json'))
const marker = join(pkgDir, '.abi-target')
const binary = join(pkgDir, 'build', 'Release', 'better_sqlite3.node')

let electronVersion = null
if (target === 'electron') {
  const electronPkg = JSON.parse(
    readFileSync(join(dirname(require.resolve('electron/package.json')), 'package.json'), 'utf8'),
  )
  electronVersion = electronPkg.version
}

const wanted = target === 'electron' ? `electron@${electronVersion}` : `node@${process.versions.node}`
if (existsSync(marker) && existsSync(binary) && readFileSync(marker, 'utf8') === wanted) {
  process.exit(0)
}

const prebuildInstall = require.resolve('prebuild-install/bin.js')
const args = [prebuildInstall, '--verbose']
if (target === 'electron') {
  args.push('--runtime=electron', `--target=${electronVersion}`)
}

try {
  execFileSync(process.execPath, args, { cwd: pkgDir, stdio: 'inherit' })
} catch {
  if (target === 'node') {
    console.warn('prebuild-install failed; attempting a source rebuild for Node...')
    execFileSync('npm', ['rebuild', 'better-sqlite3'], { stdio: 'inherit', shell: true })
  } else {
    console.error(
      `No prebuilt better-sqlite3 binary is available for Electron ${electronVersion}. ` +
        'Install a C++ build toolchain and run: npx electron-rebuild -f -w better-sqlite3',
    )
    process.exit(1)
  }
}

writeFileSync(marker, wanted)
console.log(`better-sqlite3 binary now targets ${wanted}`)
