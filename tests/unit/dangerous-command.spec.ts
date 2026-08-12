// isDangerousCommand is the last gate before a Bash command can become a
// permanent always-allow standing rule (see the doc comment above it in
// @shared/domain, and the refusal it backs in rules.standing.add,
// handlers.ts ~L871: three call sites write standing rules and this is what
// stops "rm -rf" or "git push --force" from being one of the two that grant a
// permanent auto-approval the inbox itself would never create). It is
// deliberately narrower than the risk classifier — ordinary vetted commands
// the classifier fails safe-to-high on must still be eligible here. Nothing
// in the repo exercised this function directly before this file.
//
// tests/e2e/mock-host.ts cannot import it — that file is serialised into the
// page via addInitScript — so it keeps its own copy of the regex by hand,
// twice over (inbox.alwaysAllow and inbox.approveAlways). Reading those
// copies back out of the source, rather than re-typing them here too, means a
// change to either regex without the other shows up as a failing test instead
// of a silent disagreement between the inbox flow and the Settings flow.
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

/** Runs one command through the real function and every mock-host copy, and requires agreement. */
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

  // The doc comment above the function names mkdir, "make build" and "python x"
  // as commands the risk classifier fails safe-to-high on but that must still
  // be eligible for "always allow" — that gap between the classifier and this
  // function is the reason it exists. git status and git commit round out the
  // "ordinary" side of the git family this function otherwise restricts.
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
    // "terraform" contains "rm", "sudoku" contains "sudo", "reformat" and
    // "update the model" each contain "del" or "format" as a sub-string of a
    // longer word. None of these is the command it happens to contain, and
    // the regex's \b anchors are what keeps them out of the refusal.
    checkBoth('terraform apply', false)
    checkBoth('sudoku-solver run', false)
    checkBoth('reformat the code', false)
    checkBoth('update the model', false)
  })

  it('only bars "git reset --hard", not other reset flavours such as --soft', () => {
    checkBoth('git reset --soft HEAD~1', false)
  })

  // A formatter is not a disk format. `\bformat\b` used to bar the bare word
  // anywhere in the command, which refused `npm run format` and `dotnet format`
  // — the latter being a command this app's own suite catalogue tells projects
  // to run. Both are exactly the ordinary vetted commands the doc comment says
  // must stay eligible, so `format` now only matches when a drive follows it.
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
