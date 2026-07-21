// Update check via the GitHub Releases API. Releases ship the installer only
// (no electron-updater `latest.yml` feed), so instead of a silent background
// download this asks GitHub for the latest release, compares its tag to the
// running version, and — when newer — points the user at the release page to
// download and run the installer. No latest.yml means no YAML parse errors.
import { app, shell } from 'electron'
import type { UpdateStatus } from '@shared/ipc-types'

const REPO = 'DivanLR/SwitchBoard'
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`

export interface UpdaterDeps {
  onStatus: (status: UpdateStatus) => void
}

let deps: UpdaterDeps | null = null
/** Release page for the newest version seen by the last check (for installNow). */
let latestUrl: string = RELEASES_PAGE

export function initUpdater(d: UpdaterDeps): void {
  deps = d
  // Check once on startup in packaged builds; dev builds check only on demand.
  if (app.isPackaged) void check()
}

function emit(status: UpdateStatus): void {
  deps?.onStatus(status)
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

export async function check(): Promise<UpdateStatus['state']> {
  emit({ state: 'checking' })
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Switchboard-Updater' },
    })
    if (!res.ok) throw new Error(`GitHub API returned ${res.status}`)
    const release = (await res.json()) as { tag_name?: string; html_url?: string }
    const latest = (release.tag_name ?? '').replace(/^v/i, '').trim()
    if (latest && isNewer(latest, app.getVersion())) {
      latestUrl = release.html_url ?? RELEASES_PAGE
      emit({ state: 'available', version: latest, url: latestUrl })
      return 'available'
    }
    emit({ state: 'none' })
    return 'none'
  } catch (err) {
    emit({ state: 'error', message: err instanceof Error ? err.message : String(err) })
    return 'error'
  }
}

/** Open the release page in the browser so the user can download the installer. */
export function installNow(): void {
  void shell.openExternal(latestUrl)
}
