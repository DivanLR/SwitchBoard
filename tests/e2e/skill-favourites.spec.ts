import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario, type MockScenario } from './mock-host'

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

  expect(await order(page)).toEqual(['code-review', 'write-tests', 'ship-it'])

  await page.getByTestId('skill-fav-ship-it').click()
  await expect(page.getByTestId('skills-favourites')).toBeVisible()
  expect(await order(page)).toEqual(['ship-it', 'code-review', 'write-tests'])
  await expect(page.getByTestId('skill-fav-ship-it')).toHaveAttribute('aria-pressed', 'true')

  await expect(page.getByTestId('skill-run-ship-it')).toHaveCount(1)
})

test('favourites keep the order they were starred in, not the alphabet', async ({ page }) => {
  await page.addInitScript(installMockHost, scenario())
  await openSkills(page)

  await page.getByTestId('skill-fav-ship-it').click()
  await expect(page.getByTestId('skills-favourites')).toBeVisible()
  await page.getByTestId('skill-fav-code-review').click()

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
  await page.addInitScript(installMockHost, scenario())
  await openSkills(page)

  await page.getByTestId('skill-fav-ship-it').click()
  await expect(page.getByTestId('skills-favourites')).toBeVisible()
  await page.getByTestId('skill-fav-code-review').click()
  expect(await order(page)).toEqual(['ship-it', 'code-review', 'write-tests'])

  await page.getByTestId('open-settings').click()
  const panel = page.getByTestId('settings-panel')
  await panel.getByTestId('settings-tab-skills').click()
  await panel.getByTestId('skill-toggle-ship-it').click()
  await expect(panel.getByTestId('skill-toggle-ship-it')).toHaveAttribute('aria-checked', 'false')

  await panel.getByTestId('settings-close').click()
  expect(await order(page)).toEqual(['code-review', 'write-tests'])

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
  await expect(page.getByTestId('skills-source-https://github.com/acme/skills')).toBeVisible()
})
