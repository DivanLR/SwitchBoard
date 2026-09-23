import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

function liveSkillsRoot(): string {
  return join(homedir(), '.claude', 'skills')
}

export function stagingSkillsRoot(userDataPath: string): string {
  return join(userDataPath, 'skills')
}

function assertPlainName(name: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) {
    throw new Error(`Refusing to touch a skill directory named ${JSON.stringify(name)}`)
  }
}

export async function enableSkill(stagingRoot: string, name: string): Promise<void> {
  assertPlainName(name)
  const from = join(stagingRoot, name)
  const to = join(liveSkillsRoot(), name)
  await stat(from)
  await mkdir(liveSkillsRoot(), { recursive: true })
  await rm(to, { recursive: true, force: true })
  await cp(from, to, { recursive: true })
}

export async function disableSkill(name: string): Promise<void> {
  assertPlainName(name)
  await rm(join(liveSkillsRoot(), name), { recursive: true, force: true })
}

export async function removeSkill(stagingRoot: string, name: string): Promise<void> {
  await disableSkill(name)
  await rm(join(stagingRoot, name), { recursive: true, force: true })
}

export async function reconcileSkills(
  stagingRoot: string,
  skills: readonly { name: string; enabled: boolean }[],
): Promise<void> {
  const live = new Set(await liveSkillFolders())
  for (const skill of skills) {
    if (!skill.enabled || live.has(skill.name)) continue
    try {
      await enableSkill(stagingRoot, skill.name)
    } catch {}
  }
}

export async function liveSkillFolders(): Promise<string[]> {
  return (await readdir(liveSkillsRoot()).catch(() => [] as string[])).map((name) => name.toLowerCase())
}

export async function installedSkillNames(): Promise<string[]> {
  const root = liveSkillsRoot()
  const names = await readdir(root).catch(() => [] as string[])
  const live = await Promise.all(
    names.map((name) =>
      stat(join(root, name, 'SKILL.md')).then(
        () => name,
        () => null,
      ),
    ),
  )
  return live.filter((name): name is string => name !== null).sort()
}
