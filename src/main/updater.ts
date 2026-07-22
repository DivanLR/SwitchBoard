// Update check + in-app install via the GitHub Releases API. Releases ship the
// NSIS installer only (no electron-updater `latest.yml` feed, so no YAML parse
// errors). On check this compares the latest release tag to the running
// version; on install it downloads that release's installer asset inside the
// app, reporting progress, then launches it and quits so it can replace files.
import { app, shell } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { UpdateStatus } from '@shared/ipc-types'

const execFileAsync = promisify(execFile)

const REPO = 'DivanLR/SwitchBoard'
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`

export interface UpdaterDeps {
  onStatus: (status: UpdateStatus) => void
}

let deps: UpdaterDeps | null = null
/** Release page for the newest version seen by the last check (browser fallback). */
let latestUrl: string = RELEASES_PAGE
/** Direct installer-asset download URL from the last check, if one was found. */
let latestAssetUrl: string | null = null
let latestVersion = ''

export function initUpdater(d: UpdaterDeps): void {
  deps = d
  // Check once on startup in packaged builds; dev builds check only on demand.
  if (app.isPackaged) void check()
}

function emit(status: UpdateStatus): void {
  deps?.onStatus(status)
}

/** Accept a github.com URL under our own repo; else null. Guards what we open
 *  or download against untrusted GitHub API fields (Electron A15/E6). */
function safeGithubUrl(candidate: string | undefined): string | null {
  try {
    const u = new URL(candidate ?? '')
    if (u.origin === 'https://github.com' && u.pathname.startsWith(`/${REPO}/`)) return u.href
  } catch {
    // fall through
  }
  return null
}

/** True when semver-ish string `a` is strictly newer than `b` (numeric compare). */
function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff > 0
  }
  return false
}

interface GithubAsset {
  name?: string
  browser_download_url?: string
}

export async function check(): Promise<UpdateStatus['state']> {
  emit({ state: 'checking' })
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Switchboard-Updater' },
    })
    if (!res.ok) throw new Error(`GitHub API returned ${res.status}`)
    const release = (await res.json()) as {
      tag_name?: string
      html_url?: string
      assets?: GithubAsset[]
    }
    const latest = (release.tag_name ?? '').replace(/^v/i, '').trim()
    if (latest && isNewer(latest, app.getVersion())) {
      latestVersion = latest
      latestUrl = safeGithubUrl(release.html_url) ?? RELEASES_PAGE
      // The NSIS installer asset (Switchboard-Setup-x.y.z.exe) drives the
      // in-app download; if absent, install falls back to the browser page.
      const installer = (release.assets ?? []).find((a) => /\.exe$/i.test(a.name ?? ''))
      latestAssetUrl = safeGithubUrl(installer?.browser_download_url)
      emit({ state: 'available', version: latest })
      return 'available'
    }
    emit({ state: 'none' })
    return 'none'
  } catch (err) {
    emit({ state: 'error', message: err instanceof Error ? err.message : String(err) })
    return 'error'
  }
}

/**
 * Refuse to launch an installer that is not carrying a valid Authenticode
 * signature. TLS + the origin-validated download guard the transport; this
 * guards the authenticity of what actually executes (Electron A15/D). When the
 * build is not yet code-signed (see electron-builder.yml) the status is not
 * 'Valid', so the caller falls back to the browser download rather than running
 * an unverified binary. Windows-only, matching the sole packaged target.
 */
async function hasValidSignature(filePath: string): Promise<boolean> {
  const psPath = `'${filePath.replace(/'/g, "''")}'`
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-AuthenticodeSignature -LiteralPath ${psPath}).Status`,
      ],
      { timeout: 15000, windowsHide: true },
    )
    return stdout.trim() === 'Valid'
  } catch {
    return false
  }
}

/**
 * Download the release installer inside the app (reporting progress), verify its
 * signature, then launch it and quit so it can replace the running files. Falls
 * back to opening the release page in the browser when no installer asset was
 * found on the last check (e.g. a release that attached only source archives),
 * or when the downloaded installer fails signature verification.
 */
export async function installNow(): Promise<void> {
  if (!latestAssetUrl) {
    await shell.openExternal(latestUrl)
    return
  }
  try {
    emit({ state: 'downloading', version: latestVersion, percent: 0 })
    // fetch follows GitHub's redirect to the asset CDN automatically.
    const res = await fetch(latestAssetUrl, { headers: { 'User-Agent': 'Switchboard-Updater' } })
    if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`)
    const total = Number(res.headers.get('content-length')) || 0
    const reader = res.body.getReader()
    const chunks: Buffer[] = []
    let received = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        chunks.push(Buffer.from(value))
        received += value.length
        if (total > 0) {
          emit({
            state: 'downloading',
            version: latestVersion,
            percent: Math.min(100, Math.round((received / total) * 100)),
          })
        }
      }
    }
    // Version comes from a GitHub tag; keep only digits/dots so it can never
    // steer the temp write/launch path outside the temp directory.
    const safeVersion = latestVersion.replace(/[^0-9.]/g, '') || 'latest'
    const dest = join(app.getPath('temp'), `Switchboard-Setup-${safeVersion}.exe`)
    writeFileSync(dest, Buffer.concat(chunks))
    // Never execute an unverified binary. An unsigned build fails this and falls
    // back to the browser download rather than running unverified code.
    if (!(await hasValidSignature(dest))) {
      rmSync(dest, { force: true })
      emit({
        state: 'error',
        message: 'The downloaded update could not be verified; opened the release page instead.',
      })
      await shell.openExternal(latestUrl)
      return
    }
    emit({ state: 'ready', version: latestVersion })
    // Detach the installer so it survives our exit, then quit to unlock files.
    spawn(dest, { detached: true, stdio: 'ignore' }).unref()
    app.quit()
  } catch (err) {
    emit({ state: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
