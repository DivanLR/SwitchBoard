import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isDangerousCommand } from '@shared/domain'

const mockHostSource = readFileSync(
  fileURLToPath(new URL('../e2e/mock-host.ts', import.meta.url)),
  'utf8',
)
const mockHostRegexes = [...mockHostSource.matchAll(/const dangerous = \/(.+)\/([a-z]*)/g)].map(
  ([, pattern, flags]) => new RegExp(pattern, flags),
)

describe('the mock host copy of the regex', () => {
  it('is still present to compare against — a rewrite of mock-host.ts should update this file too', () => {
    expect(mockHostRegexes.length).toBeGreaterThan(0)
  })

  it('is the same copy in both handlers it appears in, not two regexes drifting independently', () => {
    const distinct = new Set(mockHostRegexes.map((r) => `${r.source}::${r.flags}`))
    expect(distinct.size).toBe(1)
  })
})

function checkBoth(command: string, expected: boolean): void {
  expect(isDangerousCommand(command)).toBe(expected)
  for (const regex of mockHostRegexes) {
    expect(regex.test(command)).toBe(expected)
  }
}

describe('isDangerousCommand', () => {
  it.each([
    ['rm', 'rm -rf dist'],
    ['rmdir', 'rmdir /s /q old'],
    ['del', 'del file.txt'],
    ['rd', 'rd /s /q folder'],
    ['format', 'format C:'],
    ['mkfs', 'mkfs.ext4 /dev/sda1'],
    ['dd', 'dd if=/dev/zero of=/dev/sda'],
    ['sudo', 'sudo apt-get install curl'],
    ['doas', 'doas reboot'],
    ['Remove-Item', 'Remove-Item -Recurse -Force .\\bin'],
    ['git push', 'git push origin main'],
    ['git reset --hard', 'git reset --hard HEAD~1'],
    ['git clean', 'git clean -fd'],
  ])('refuses %s, one of the design\u2019s locked destructive families', (_family, command) => {
    checkBoth(command, true)
  })

  it.each([
    ['mkdir', 'mkdir build'],
    ['make build', 'make build'],
    ['python x', 'python x'],
    ['npm test', 'npm test'],
    ['git status', 'git status'],
    ['git commit', 'git commit -m "message"'],
  ])('leaves %s eligible for a standing rule', (_label, command) => {
    checkBoth(command, false)
  })

  it('is case-insensitive, so upper-casing a command cannot dodge the refusal', () => {
    checkBoth('RM -rf dist', true)
    checkBoth('SUDO apt-get install curl', true)
    checkBoth('Git Push origin main', true)
    checkBoth('DEL C:\\Windows\\System32', true)
  })

  it('matches on word boundaries, so a word merely containing a dangerous word is not refused', () => {
    checkBoth('terraform apply', false)
    checkBoth('sudoku-solver run', false)
    checkBoth('reformat the code', false)
    checkBoth('update the model', false)
  })

  it('only bars "git reset --hard", not other reset flavours such as --soft', () => {
    checkBoth('git reset --soft HEAD~1', false)
  })

  it('lets a formatter through, because a formatter is not a disk format', () => {
    checkBoth('npm run format', false)
    checkBoth('dotnet format --verify-no-changes', false)
    checkBoth('npx prettier --write .', false)
  })

  it('still refuses an actual disk format, which always names the drive it wipes', () => {
    checkBoth('format C:', true)
    checkBoth('format d: /q', true)
  })
})
