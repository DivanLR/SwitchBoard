// Reading a GitHub URL into the repository, ref and folder it names.
//
// In `shared` rather than beside the importer that uses it, because BOTH sides
// need the same answer and only one of them can make a request. The main process
// parses to decide what to fetch; the renderer parses to tell the developer what
// their URL actually says — which repository, which branch, which folder —
// before they commit to an import that reaches over the network.
//
// The renderer used to have no way to know, so a mistyped URL was indistinguishable
// from an empty folder until the round trip failed. Duplicating the rules here
// would have been worse than the silence: two copies of "what counts as a valid
// repository path" drift, and the copy that drifts is the one deciding what gets
// written to disk.
//
// Returns a verdict rather than throwing, because "not valid yet" is the normal
// state of a field someone is halfway through typing. The importer wraps a
// failure into the IpcError it has always thrown.

/** Owner, repository and ref as GitHub itself allows them, and no more. Anything
 *  outside this never reaches a URL. */
const SEGMENT = /^[A-Za-z0-9._-]+$/

export interface SkillSource {
  owner: string
  repo: string
  /** Branch, tag or commit. Null means the repository's own default branch. */
  ref: string | null
  /** Repository-relative directory to read, '' for the whole repository. */
  path: string
}

export type SkillSourceResult =
  | { ok: true; source: SkillSource }
  | { ok: false; message: string }

/**
 * A repository-relative path that is safe to turn into a filename.
 *
 * Rejects absolute forms, Windows drive letters, UNC prefixes and any `..`
 * segment. Applied to the URL's own folder AND to every path in the tree the
 * request answers with, because a tree is remote data and a hostile repository
 * can put anything in one.
 */
export function isSafeRepoPath(path: string): boolean {
  if (path === '') return true
  // A backslash ANYWHERE, not merely a leading one: on Windows it is a separator,
  // so `a\..\..\b` climbs out of a directory that `a/../../b` would have been
  // caught climbing out of. NUL truncates a path in some system calls, which is
  // the same escape by a different route.
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false
  if (/^[A-Za-z]:/.test(path)) return false
  return path.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..')
}

/**
 * Read a GitHub URL into its parts, refusing anything that is not one.
 *
 * Accepts the three forms a developer actually pastes: the repository root, a
 * `/tree/<ref>/<path>` deep link (what the "browse a folder" URL looks like), and
 * the same with a trailing slash or `.git`.
 */
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
  // /tree/<ref>/<path...> and /blob/<ref>/<path...> are the browse forms; anything
  // else after the repository name is not something this can read.
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

/**
 * A single URL segment — owner, repository, branch or tag — as GitHub itself
 * allows them and no more.
 *
 * Exported because the importer validates one more segment than a URL carries:
 * the default branch a repository reports back. That name also reaches a request,
 * so it is checked against the same class rather than a second one written to
 * look like it.
 */
export function isSafeSegment(value: string): boolean {
  return SEGMENT.test(value)
}

/** `owner/repo`, the part of a source worth reading on a row. */
export function skillSourceLabel(source: SkillSource): string {
  return `${source.owner}/${source.repo}`
}
