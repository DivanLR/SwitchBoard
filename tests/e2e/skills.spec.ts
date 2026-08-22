// Custom skills: import a repository in Settings, switch skills on and off, and
// run one from the Skills section.
//
// The split under test is the one the owner asked for: Settings MANAGES them and
// the section USES them. So the two halves are exercised together, because the
// thing that can break is the join between them — a skill switched off in
// Settings has to disappear from the section immediately.
import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario, type MockScenario } from './mock-host'

/** What the next import "finds". Shaped like the frontmatter a real SKILL.md
 *  carries, because that is what the importer reads. */
const FOUND = [
  {
    name: 'code-review',
    description: 'Review a diff for correctness.',
    sourceUrl: '',
    sourcePath: 'skills/engineering/code-review',
    enabled: true,
    fileCount: 3,
    importedAt: '2026-08-21T09:00:00.000Z',
  },
  {
    name: 'write-tests',
    description: 'Write tests for the changed code.',
    sourceUrl: '',
    sourcePath: 'skills/engineering/write-tests',
    enabled: true,
    fileCount: 2,
    importedAt: '2026-08-21T09:00:00.000Z',
  },
]

function scenarioWith(skills: MockScenario['skills']): MockScenario {
  return { ...twoProjectScenario(), skills }
}

test('a GitHub folder becomes a list of skills, and only github.com is accepted', async ({
  page,
}) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await page.evaluate((found) => window.__mock.setSkillImport(found), FOUND)

  await page.getByTestId('open-settings').click()
  const panel = page.getByTestId('settings-panel')
  await panel.getByTestId('settings-tab-skills').click()
  await expect(panel.getByTestId('skills-none')).toBeVisible()

  // Anything that is not a github.com URL is refused BEFORE a request is made —
  // and now before the click, too: the field reads the URL as it is typed and the
  // button will not arm for one that cannot work. This used to cost a round trip
  // to learn.
  await panel.getByTestId('skills-url-input').fill('https://gitlab.com/owner/repo')
  await expect(panel.getByTestId('skills-url-problem')).toContainText('github.com')
  await expect(panel.getByTestId('skills-import-btn')).toBeDisabled()

  await panel.getByTestId('skills-url-input').fill('https://github.com/mattpocock/skills/tree/main/skills/engineering')
  await expect(panel.getByTestId('skills-import-btn')).toBeEnabled()
  await panel.getByTestId('skills-import-btn').click()

  await expect(panel.getByTestId('skill-row-code-review')).toBeVisible()
  await expect(panel.getByTestId('skill-row-write-tests')).toBeVisible()
  // Imported switched on, so the repository the developer asked for is usable
  // without ticking every skill by hand.
  await expect(panel.getByTestId('skill-toggle-code-review')).toHaveAttribute('aria-checked', 'true')
})

// The field used to be opaque: paste anything, press Import, wait for the network
// to tell you whether it was even a repository. It now reads the URL with the
// importer's OWN parser (@shared/skill-source), so what will be fetched is on
// screen before anything is fetched.
test('the pasted URL says what it names, before anything is requested', async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await page.getByTestId('open-settings').click()
  const panel = page.getByTestId('settings-panel')
  await panel.getByTestId('settings-tab-skills').click()

  // An empty field is not an error, so it says nothing at all.
  await expect(panel.getByTestId('skills-url-reading')).toHaveCount(0)
  await expect(panel.getByTestId('skills-url-problem')).toHaveCount(0)

  const reading = panel.getByTestId('skills-url-reading')

  await panel
    .getByTestId('skills-url-input')
    .fill('https://github.com/mattpocock/skills/tree/main/skills/engineering')
  await expect(reading).toContainText('mattpocock/skills')
  await expect(reading).toContainText('main')
  await expect(reading).toContainText('skills/engineering')

  // A bare repository imports all of it, and says so rather than leaving the
  // folder blank — blank would read as "nothing will be imported".
  await panel.getByTestId('skills-url-input').fill('https://github.com/owner/repo')
  await expect(reading).toContainText('whole repository')
  // No ref in the URL means the repository's own default, which is a fact, not
  // a guess at "main".
  await expect(reading).toContainText('default branch')
})

test('a URL that names no repository says which part is wrong', async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await page.getByTestId('open-settings').click()
  const panel = page.getByTestId('settings-panel')
  await panel.getByTestId('settings-tab-skills').click()
  const input = panel.getByTestId('skills-url-input')
  const problem = panel.getByTestId('skills-url-problem')

  await input.fill('not a url at all')
  await expect(problem).toContainText('not a URL')

  await input.fill('https://github.com/owner')
  await expect(problem).toContainText('github.com/owner/repo')

  // A deep link that is neither /tree/ nor /blob/ is something this cannot read,
  // and saying so beats "import failed".
  await input.fill('https://github.com/owner/repo/issues/4')
  await expect(problem).toContainText('/tree/')

  await expect(panel.getByTestId('skills-import-btn')).toBeDisabled()
})

test('imported skills are grouped by repository, and a whole source switches at once', async ({
  page,
}) => {
  await page.addInitScript(
    installMockHost,
    scenarioWith(
      FOUND.map((s) => ({ ...s, sourceUrl: 'https://github.com/mattpocock/skills', enabled: true })),
    ),
  )
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await page.getByTestId('open-settings').click()
  const panel = page.getByTestId('settings-panel')
  await panel.getByTestId('settings-tab-skills').click()

  // The source is stated once for the group rather than on every row.
  const group = panel.getByTestId('skill-group-mattpocock/skills')
  await expect(group).toBeVisible()
  await expect(group).toContainText('2/2 on')

  // One click for the whole repository, instead of one per skill.
  await panel.getByTestId('skill-group-all-mattpocock/skills').click()
  await expect(panel.getByTestId('skill-toggle-code-review')).toHaveAttribute('aria-checked', 'false')
  await expect(panel.getByTestId('skill-toggle-write-tests')).toHaveAttribute('aria-checked', 'false')
  await expect(group).toContainText('0/2 on')

  await panel.getByTestId('skill-group-all-mattpocock/skills').click()
  await expect(group).toContainText('2/2 on')
})

test('a skill switched off in Settings leaves the section immediately', async ({ page }) => {
  await page.addInitScript(installMockHost, scenarioWith(FOUND.map((s) => ({ ...s, sourceUrl: 'https://github.com/o/r' }))))
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()

  await page.getByTestId('tab-skills').click()
  await expect(page.getByTestId('skill-run-code-review')).toBeVisible()
  await expect(page.getByTestId('skill-run-write-tests')).toBeVisible()

  await page.getByTestId('open-settings').click()
  const panel = page.getByTestId('settings-panel')
  await panel.getByTestId('settings-tab-skills').click()
  await panel.getByTestId('skill-toggle-write-tests').click()
  await panel.getByTestId('settings-close').click()

  // One store behind both surfaces, so the section is already right.
  await expect(page.getByTestId('skill-run-code-review')).toBeVisible()
  await expect(page.getByTestId('skill-run-write-tests')).toHaveCount(0)
})

test('running a skill sends its slash command to the Skills section session', async ({ page }) => {
  await page.addInitScript(installMockHost, scenarioWith(FOUND.map((s) => ({ ...s, sourceUrl: 'https://github.com/o/r' }))))
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()

  await page.getByTestId('tab-skills').click()
  await page.getByTestId('skill-run-code-review').click()

  const sends = async () => page.evaluate(() => window.__mock.state().sends)
  await expect.poll(async () => (await sends()).at(-1)?.text).toBe('/code-review')
  // Its own session, not the conversation: a skill is section work like any other.
  expect((await sends()).at(-1)?.sessionId).not.toBe('s-alpha')
})

test('a skill can be given an argument, the way a slash command takes one', async ({ page }) => {
  await page.addInitScript(installMockHost, scenarioWith(FOUND.map((s) => ({ ...s, sourceUrl: 'https://github.com/o/r' }))))
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()

  await page.getByTestId('tab-skills').click()
  await page.getByTestId('skill-arg-code-review').click()
  await page.getByTestId('skill-arg-input-code-review').fill('only the diff store')
  await page.getByTestId('skill-arg-input-code-review').press('Enter')

  await expect
    .poll(async () => (await page.evaluate(() => window.__mock.state().sends)).at(-1)?.text)
    .toBe('/code-review only the diff store')
})

test('the section says which of the two empty states it is in', async ({ page }) => {
  // Nothing imported at all, and everything switched off, need different answers:
  // one sends you to add a repository, the other to switch one on.
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await page.getByTestId('tab-skills').click()
  await expect(page.getByTestId('skills-empty')).toBeVisible()

  await page.evaluate(() => window.__mock.setSkillImport([]))
  await page.reload()
  await page.getByTestId('sidebar-project-alpha').click()
  await page.getByTestId('tab-skills').click()
  await expect(page.getByTestId('skills-empty')).toBeVisible()
})
