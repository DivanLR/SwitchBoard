// Where an imported skill's files live, and what "enabled" physically means.
//
// TWO DIRECTORIES, on purpose:
//
//   staging   %APPDATA%/terminal-switchboard/skills/<name>/
//             Every imported skill, switched on or off. This app owns it, so
//             nothing here is read by the CLI and nothing here changes what a
//             session can do.
//
//   live      ~/.claude/skills/<name>/
//             Only the enabled ones. This is the CLI's own user-skills directory,
//             so a directory appearing here IS the skill becoming available, to
//             every project and every session at once.
//
// Enabling copies staging to live; disabling removes the live copy. Keeping the
// staging copy is what makes disable reversible without going back to GitHub,
// and it is why a repository that has since been deleted does not cost the
// developer a skill they had already imported.
//
// The alternative — one directory, with disabled skills renamed out of the way —
// was rejected: it puts this app's bookkeeping inside a directory the CLI scans
// and the developer edits by hand, and a rename convention that the CLI later
// decides to read is a silent re-enable.
import { cp, mkdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The CLI's user-level skills directory. Not configurable, because the CLI's
 *  own location is not. */
export function liveSkillsRoot(): string {
  return join(homedir(), '.claude', 'skills')
}

/**
 * Where imported skills are kept regardless of state.
 *
 * Under the app's own user-data directory, beside the database, so it is backed
 * up and removed with everything else this app owns. Passed in rather than read
 * from `app.getPath` here so the unit tests can point it at a temp directory
 * without an Electron runtime.
 */
export function stagingSkillsRoot(userDataPath: string): string {
  return join(userDataPath, 'skills')
}

/** A skill name is a single path segment and has already been validated by
 *  isUsableSkillName; this refuses anything that slipped past, because these two
 *  functions delete directories. */
function assertPlainName(name: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) {
    throw new Error(`Refusing to touch a skill directory named ${JSON.stringify(name)}`)
  }
}

/**
 * Make a staged skill visible to every session.
 *
 * Copies rather than symlinks. A symlink would be cheaper and is the obvious
 * choice, and it is the wrong one here for two reasons: this app already had a
 * symlink escape to fix once (see the 0.19.0 release), and a link into a
 * directory the app can delete means uninstalling a skill can break a CLI that
 * is midway through reading it. A copy is inert.
 */
export async function enableSkill(stagingRoot: string, name: string): Promise<void> {
  assertPlainName(name)
  const from = join(stagingRoot, name)
  const to = join(liveSkillsRoot(), name)
  await stat(from) // absent staging is a real error: there is nothing to enable
  await mkdir(liveSkillsRoot(), { recursive: true })
  await rm(to, { recursive: true, force: true })
  await cp(from, to, { recursive: true })
}

/** Take a skill out of the CLI's reach, keeping the staged copy so it can come
 *  back without another download. */
export async function disableSkill(name: string): Promise<void> {
  assertPlainName(name)
  await rm(join(liveSkillsRoot(), name), { recursive: true, force: true })
}

/** Remove a skill entirely: the live copy and the staged one. */
export async function removeSkill(stagingRoot: string, name: string): Promise<void> {
  assertPlainName(name)
  await rm(join(liveSkillsRoot(), name), { recursive: true, force: true })
  await rm(join(stagingRoot, name), { recursive: true, force: true })
}

/**
 * Put the filesystem back in step with the registry.
 *
 * Run at startup, because the two can drift while the app is not running: a
 * developer can delete ~/.claude/skills/<name> by hand, or restore a machine from
 * a backup that has the database but not the directory. Reconciling on the
 * registry's word means the switch in Settings is always telling the truth about
 * what a session will see.
 */
export async function reconcileSkills(
  stagingRoot: string,
  skills: readonly { name: string; enabled: boolean }[],
): Promise<void> {
  for (const skill of skills) {
    try {
      if (skill.enabled) await enableSkill(stagingRoot, skill.name)
      else await disableSkill(skill.name)
    } catch {
      // Best effort, and silent by design: one unreadable skill directory must
      // not stop the application from starting. The row stays, so the developer
      // can see it in Settings and remove it.
    }
  }
}
