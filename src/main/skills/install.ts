import { cp, mkdir, rm, stat } from 'node:fs/promises'
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
