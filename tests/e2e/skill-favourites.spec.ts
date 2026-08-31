// Starring skills so the ones actually used sit at the top.
//
// Twenty imported skills grouped by the six repositories they came from is an
// honest list and a slow one: the three reached for daily are wherever their
// repository happens to sort. These tests cover the three things that make a
// favourites list worth having — it lifts, it holds its own order, and it
// survives a restart.
import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario, type MockScenario } from './mock-host'

/** Three skills from two repositories, so hoisting is visible: a favourite has
 *  to leave its source group and appear above every one of them. */
const SKILLS = [
  {
    name: 'code-review',
    description: 'Review a diff for correctness.',
    sourceUrl: 'https://github.com/acme/skills',
    sourcePath: 'skills/code-review',
    enabled: true,
    fileCount: 3,
    importedAt: '2026-08-21T09:00:00.000Z',
  },
  {
    name: 'write-tests',
    description: 'Write tests for the changed code.',
    sourceUrl: 'https://github.com/acme/skills',
    sourcePath: 'skills/write-tests',
    enabled: true,
    fileCount: 2,
    importedAt: '2026-08-21T09:00:00.000Z',
  },
  {
    name: 'ship-it',
    description: 'Cut a release.',
    sourceUrl: 'https://github.com/other/tools',
    sourcePath: 'skills/ship-it',
    enabled: true,
    fileCount: 1,
    importedAt: '2026-08-21T09:00:00.000Z',
  },
]

function scenario(skills: MockScenario['skills'] = SKILLS): MockScenario {
  return { ...twoProjectScenario(), skills }
}

async function openSkills(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await page.getByTestId('sidebar-project-alpha').click()
  await page.getByTestId('tab-skills').click()
  await expect(page.getByTestId('skills-view')).toBeVisible()
}

/** Every skill row in the order it renders, which is what "at the top" means. */
async function order(page: import('@playwright/test').Page): Promise<string[]> {
  return page.locator('[data-testid^="skill-run-"]').evaluateAll((rows) =>
    rows.map((row) => (row.getAttribute('data-testid') ?? '').replace('skill-run-', '')),
  )
}

test('with nothing starred there is no favourites block, just the source groups', async ({
  page,
}) => {
  await page.addInitScript(installMockHost, scenario())
  await openSkills(page)

  await expect(page.getByTestId('skills-favourites')).toHaveCount(0)
  await expect(page.getByTestId('skill-fav-code-review')).toHaveAttribute('aria-pressed', 'false')
})

test('starring a skill lifts it out of its repository and to the top', async ({ page }) => {
  await page.addInitScript(installMockHost, scenario())
  await openSkills(page)

  // ship-it is in the second repository, so it starts last.
  expect(await order(page)).toEqual(['code-review', 'write-tests', 'ship-it'])

  await page.getByTestId('skill-fav-ship-it').click()
  await expect(page.getByTestId('skills-favourites')).toBeVisible()
  expect(await order(page)).toEqual(['ship-it', 'code-review', 'write-tests'])
  await expect(page.getByTestId('skill-fav-ship-it')).toHaveAttribute('aria-pressed', 'true')

  // Hoisted, not copied: it appears once. Two rows for one skill would be two
  // Run buttons that do the same thing.
  await expect(page.getByTestId('skill-run-ship-it')).toHaveCount(1)
})

test('favourites keep the order they were starred in, not the alphabet', async ({ page }) => {
  await page.addInitScript(installMockHost, scenario())
  await openSkills(page)

  await page.getByTestId('skill-fav-ship-it').click()
  await expect(page.getByTestId('skills-favourites')).toBeVisible()
  await page.getByTestId('skill-fav-code-review').click()

  // ship-it was starred first and stays first. Alphabetical would put
  // code-review above it; the source order would too.
  expect(await order(page)).toEqual(['ship-it', 'code-review', 'write-tests'])
})

test('unstarring puts a skill back under the repository it came from', async ({ page }) => {
  await page.addInitScript(installMockHost, scenario())
  await openSkills(page)

  await page.getByTestId('skill-fav-ship-it').click()
  await expect(page.getByTestId('skills-favourites')).toBeVisible()
  await page.getByTestId('skill-fav-ship-it').click()

  await expect(page.getByTestId('skills-favourites')).toHaveCount(0)
  expect(await order(page)).toEqual(['code-review', 'write-tests', 'ship-it'])
})

test('a starred skill still runs, and runs the same skill', async ({ page }) => {
  await page.addInitScript(installMockHost, scenario())
  await openSkills(page)

  await page.getByTestId('skill-fav-write-tests').click()
  await expect(page.getByTestId('skills-favourites')).toBeVisible()
  await page.getByTestId('skill-run-write-tests').click()

  await expect
    .poll(async () => page.evaluate(() => window.__mock.state().sends.at(-1)?.text ?? ''))
    .toContain('write-tests')
})

test('the star survives leaving the section, because it is a preference', async ({ page }) => {
  await page.addInitScript(installMockHost, scenario())
  await openSkills(page)

  await page.getByTestId('skill-fav-ship-it').click()
  await expect(page.getByTestId('skills-favourites')).toBeVisible()

  await page.getByTestId('tab-session').click()
  await page.getByTestId('tab-skills').click()

  await expect(page.getByTestId('skills-favourites')).toBeVisible()
  expect(await order(page)).toEqual(['ship-it', 'code-review', 'write-tests'])
})

test('a star outlives switching the skill off, and comes back in its old place', async ({
  page,
}) => {
  // The guarantee Settings.favouriteSkills documents: the list holds NAMES, and
  // a name whose skill is currently absent keeps its position rather than being
  // tidied away. Rebuilding the list from the rendered favourites instead would
  // silently drop the star of anything switched off — and switching it back on
  // would find it no longer a favourite.
  await page.addInitScript(installMockHost, scenario())
  await openSkills(page)

  await page.getByTestId('skill-fav-ship-it').click()
  await expect(page.getByTestId('skills-favourites')).toBeVisible()
  await page.getByTestId('skill-fav-code-review').click()
  expect(await order(page)).toEqual(['ship-it', 'code-review', 'write-tests'])

  // Switch the FIRST favourite off in Settings, where skills are managed.
  await page.getByTestId('open-settings').click()
  const panel = page.getByTestId('settings-panel')
  await panel.getByTestId('settings-tab-skills').click()
  await panel.getByTestId('skill-toggle-ship-it').click()
  await expect(panel.getByTestId('skill-toggle-ship-it')).toHaveAttribute('aria-checked', 'false')

  await panel.getByTestId('settings-close').click()
  // It is gone from the section, because a disabled skill is not on disk and a
  // session would answer "Unknown command" — but code-review still leads.
  expect(await order(page)).toEqual(['code-review', 'write-tests'])

  // Back on, and it returns to FIRST, not to the end.
  await page.getByTestId('open-settings').click()
  await panel.getByTestId('settings-tab-skills').click()
  await panel.getByTestId('skill-toggle-ship-it').click()
  await panel.getByTestId('settings-close').click()
  expect(await order(page)).toEqual(['ship-it', 'code-review', 'write-tests'])
})

test('a source group that gave up all its skills disappears rather than sitting empty', async ({
  page,
}) => {
  await page.addInitScript(installMockHost, scenario())
  await openSkills(page)

  await expect(page.getByTestId('skills-source-https://github.com/other/tools')).toBeVisible()
  await page.getByTestId('skill-fav-ship-it').click()
  await expect(page.getByTestId('skills-source-https://github.com/other/tools')).toHaveCount(0)
  // The one that kept a skill is still there.
  await expect(page.getByTestId('skills-source-https://github.com/acme/skills')).toBeVisible()
})
