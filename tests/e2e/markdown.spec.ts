// Assistant responses render Markdown (bold, inline code, fenced blocks) in the
// clean view rather than showing raw markup.
import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await page.getByTestId('sidebar-project-alpha').click()
})

test('a Markdown response renders bold, inline code, and a fenced code block', async ({ page }) => {
  await page.evaluate(() => {
    const text = [
      '**Ponytail Audit Results**',
      '',
      'One finding, minor.',
      '',
      '```',
      'shrink  TextUtils: `?? new List()` -> `?? []`. [Chat/TextUtils.cs:17]',
      '```',
      '',
      '**net: -20 lines possible.**',
    ].join('\n')
    window.__mock.emitEvent('s-alpha', 'assistant_text', { text, partial: false })
  })

  const event = page.getByTestId('stream-event-assistant_text')
  await expect(event.locator('strong').first()).toHaveText('Ponytail Audit Results')
  await expect(event.locator('pre.md-pre code')).toContainText('shrink  TextUtils')
  // Markers inside the fence remain literal, not re-formatted.
  await expect(event.locator('pre.md-pre code')).toContainText('`?? []`')
  await expect(event.locator('pre.md-pre strong')).toHaveCount(0)
  // Raw markup is not shown as literal text outside the code block.
  await expect(event.locator('p').filter({ hasText: 'One finding' })).toBeVisible()
})

test('a Markdown response cannot inject HTML', async ({ page }) => {
  await page.evaluate(() => {
    window.__mock.emitEvent('s-alpha', 'assistant_text', {
      text: 'danger <img src=x onerror="window.__pwned=1"> done',
      partial: false,
    })
  })
  await expect(page.getByTestId('stream-event-assistant_text')).toContainText('<img')
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined()
})
