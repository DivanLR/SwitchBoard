const SEGMENT = /^[A-Za-z0-9._-]+$/

export interface SkillSource {
  owner: string
  repo: string
  ref: string | null
  path: string
}

type SkillSourceResult =
  | { ok: true; source: SkillSource }
  | { ok: false; message: string }

export function isSafeRepoPath(path: string): boolean {
  if (path === '') return true
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false
  if (/^[A-Za-z]:/.test(path)) return false
  return path.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..')
}

export function readSkillSource(input: string): SkillSourceResult {
  const raw = input.trim()
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, message: 'That is not a URL.' }
  }
  if (
    url.protocol !== 'https:' ||
    (url.hostname !== 'github.com' && url.hostname !== 'www.github.com')
  ) {
    return { ok: false, message: 'Only https://github.com URLs can be imported.' }
  }
  const parts = url.pathname.split('/').filter(Boolean)
  const owner = parts[0]
  const repo = parts[1]?.replace(/\.git$/, '')
  if (!owner || !repo || !SEGMENT.test(owner) || !SEGMENT.test(repo)) {
    return {
      ok: false,
      message: 'That URL does not name a repository. Expected github.com/owner/repo.',
    }
  }
  let ref: string | null = null
  let path = ''
  if (parts.length > 2) {
    if (parts[2] !== 'tree' && parts[2] !== 'blob') {
      return { ok: false, message: 'Link either the repository or a folder in it (a /tree/ URL).' }
    }
    ref = parts[3] ?? null
    path = parts.slice(4).join('/')
    if (ref !== null && !SEGMENT.test(ref)) {
      return { ok: false, message: 'That branch or tag name cannot be used.' }
    }
    if (!isSafeRepoPath(path)) {
      return { ok: false, message: 'That folder path cannot be used.' }
    }
  }
  return { ok: true, source: { owner, repo, ref, path } }
}

export function isSafeSegment(value: string): boolean {
  return SEGMENT.test(value)
}
