// An ended session reads as ended.
//
// The only thing that used to say a session was over was a small "Ended" pill in
// the header, above a transcript rendering at full strength — a dead session and
// a live idle one looked identical from a metre away.
//
// These tests assert the three things that treatment has to get right: it marks
// the session, it does NOT reach the way out or the other sections, and it
// leaves the transcript readable rather than inert.
import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await page.getByTestId('sidebar-project-alpha').click()
})

/** The root's own flag, which is what the greying rules hang off. */
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

  // The banner carries the mode picker, the resume switch and Start. Greying the
  // exit along with the room is how a dead end gets built, so it stays at full
  // strength — and because opacity on an ancestor composites the whole subtree,
  // that is only true if the dimming was applied to its SIBLINGS rather than to
  // the stream around it. This assertion is what proves that was done.
  const bannerOpacity = await page
    .getByTestId('ended-banner')
    .evaluate((el) => getComputedStyle(el).opacity)
  expect(bannerOpacity).toBe('1')

  // A transcript row beside it is dimmed.
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

  // This says "over", not "gone": nothing sets pointer-events, so the transcript
  // stays scrollable, selectable and copyable.
  const events = await page.evaluate(() => {
    const inner = document.querySelector('.stream-inner')
    if (!inner) return null
    const row = [...inner.children].find((el) => !el.classList.contains('ended'))
    return row ? getComputedStyle(row).pointerEvents : null
  })
  expect(events).not.toBe('none')
})

test('the raw log is dimmed too, by its own single-element rule', async ({ page }) => {
  // A different mechanism from the clean stream: .raw-view is one element with
  // no controls in it, so it takes filter: saturate() directly where the stream
  // cannot (a filter per event row would cost on every scroll).
  await page.evaluate(() => window.__mock.emitEvent('s-alpha', 'assistant', { text: 'done' }))
  await page.getByTestId('view-raw').click()
  await page.evaluate(() => window.__mock.endSession('s-alpha'))
  // The root's flag, not the ended banner: that banner lives in the CLEAN
  // stream's branch and is not rendered in the raw log at all.
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

  // A dimmed control that is nonetheless clickable is a lie. The WSL toggle,
  // "+ Session" and the rename button all outlive the session, and an ancestor
  // opacity cannot be undone by a child — so the header is left alone entirely
  // and the "Ended" pill carries the fact instead.
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

  // Diagrams starts a background session of its own, so it is fully usable with
  // the conversation over. The greying rules name the header and the stream for
  // exactly this reason rather than fading everything under the root.
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
