import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await page.getByTestId('sidebar-project-alpha').click()
})

const root = (page: import('@playwright/test').Page) =>
  page.locator('.session-view').first()

test('a live session is not marked ended', async ({ page }) => {
  await expect(root(page)).toHaveAttribute('data-session-ended', 'false')
  await expect(page.getByTestId('ended-banner')).toHaveCount(0)
})

test('ending a session marks the whole section, in the same beat as the banner', async ({
  page,
}) => {
  await page.evaluate(() => window.__mock.endSession('s-alpha'))
  await expect(page.getByTestId('ended-banner')).toBeVisible()
  await expect(root(page)).toHaveAttribute('data-session-ended', 'true')
})

test('the transcript is dimmed and the way out is not', async ({ page }) => {
  await page.evaluate(() => window.__mock.emitEvent('s-alpha', 'assistant', { text: 'done' }))
  await page.evaluate(() => window.__mock.endSession('s-alpha'))
  await expect(page.getByTestId('ended-banner')).toBeVisible()

  const bannerOpacity = await page
    .getByTestId('ended-banner')
    .evaluate((el) => getComputedStyle(el).opacity)
  expect(bannerOpacity).toBe('1')

  const dimmed = await page.evaluate(() => {
    const inner = document.querySelector('.stream-inner')
    if (!inner) return null
    const row = [...inner.children].find((el) => !el.classList.contains('ended'))
    return row ? getComputedStyle(row).opacity : null
  })
  expect(dimmed).not.toBeNull()
  expect(Number(dimmed)).toBeLessThan(1)
})

test('an ended transcript is still readable, not switched off', async ({ page }) => {
  await page.evaluate(() => window.__mock.emitEvent('s-alpha', 'assistant', { text: 'done' }))
  await page.evaluate(() => window.__mock.endSession('s-alpha'))
  await expect(page.getByTestId('ended-banner')).toBeVisible()

  const events = await page.evaluate(() => {
    const inner = document.querySelector('.stream-inner')
    if (!inner) return null
    const row = [...inner.children].find((el) => !el.classList.contains('ended'))
    return row ? getComputedStyle(row).pointerEvents : null
  })
  expect(events).not.toBe('none')
})

test('the raw log is dimmed too, by its own single-element rule', async ({ page }) => {
  await page.evaluate(() => window.__mock.emitEvent('s-alpha', 'assistant', { text: 'done' }))
  await page.getByTestId('view-raw').click()
  await page.evaluate(() => window.__mock.endSession('s-alpha'))
  await expect(root(page)).toHaveAttribute('data-session-ended', 'true')
  await expect(page.locator('.raw-view')).toBeVisible()

  const style = await page
    .locator('.raw-view')
    .evaluate((el) => {
      const s = getComputedStyle(el)
      return { opacity: s.opacity, filter: s.filter }
    })
  expect(Number(style.opacity)).toBeLessThan(1)
  expect(style.filter).toContain('saturate')
})

test('the header is NOT dimmed, because three of its controls still work', async ({ page }) => {
  await page.evaluate(() => window.__mock.endSession('s-alpha'))
  await expect(page.getByTestId('ended-banner')).toBeVisible()

  const headOpacity = await page
    .locator('.head')
    .first()
    .evaluate((el) => getComputedStyle(el).opacity)
  expect(headOpacity).toBe('1')
  await expect(page.getByTestId('new-session')).toBeEnabled()
  await expect(page.getByTestId('session-name')).toBeEnabled()
  await expect(page.getByTestId('project-containers-input')).toBeEnabled()
})

test('the other sections keep working — they do not need a live session', async ({ page }) => {
  await page.evaluate(() => window.__mock.endSession('s-alpha'))
  await expect(page.getByTestId('ended-banner')).toBeVisible()

  await page.getByTestId('tab-diagrams').click()
  await expect(page.getByTestId('diagrams-view')).toBeVisible()
  const opacity = await page
    .getByTestId('diagrams-view')
    .evaluate((el) => getComputedStyle(el).opacity)
  expect(opacity).toBe('1')
  await expect(page.getByTestId('diagram-input')).toBeEnabled()
})

test('starting a session again clears the mark', async ({ page }) => {
  await page.evaluate(() => window.__mock.endSession('s-alpha'))
  await expect(root(page)).toHaveAttribute('data-session-ended', 'true')

  await page.getByTestId('start-session').click()
  await expect(page.getByTestId('ended-banner')).toHaveCount(0)
  await expect(root(page)).toHaveAttribute('data-session-ended', 'false')
})

test('the Ended pill is a badge, not the end card that shares its class', async ({ page }) => {
  await page.evaluate(() => window.__mock.endSession('s-alpha'))
  await expect(page.getByTestId('ended-banner')).toBeVisible()

  const pill = page.locator('.pill.ended')
  await expect(pill).toBeVisible()
  const box = await pill.evaluate((el) => {
    const s = getComputedStyle(el)
    return { display: s.display, padding: s.padding, width: el.getBoundingClientRect().width }
  })
  expect(box.padding).not.toBe('20px 22px')
  expect(box.padding).not.toBe('11px 13px')
  expect(box.width).toBeLessThan(200)
})
