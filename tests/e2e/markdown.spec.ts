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
  await expect(event.locator('pre.md-pre code')).toContainText('`?? []`')
  await expect(event.locator('pre.md-pre strong')).toHaveCount(0)
  await expect(event.locator('p').filter({ hasText: 'One finding' })).toBeVisible()
})

test('a code block is copied by clicking it, and says so', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.evaluate(() => {
    window.__mock.emitEvent('s-alpha', 'assistant_text', {
      text: ['Run this:', '', '```', 'npm run check', '```'].join('\n'),
      partial: false,
    })
  })

  const block = page.getByTestId('stream-event-assistant_text').locator('pre.md-pre')
  await block.click()

  await expect(block).toHaveClass(/copied/)
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('npm run check')
})

test('the copied mark survives the next streamed token', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const eventId = await page.evaluate(() =>
    window.__mock.emitEvent('s-alpha', 'assistant_text', {
      text: ['Run this:', '', '```', 'npm run check', '```'].join('\n'),
      partial: true,
    }),
  )

  const block = page.getByTestId('stream-event-assistant_text').locator('pre.md-pre')
  await block.click()
  await expect(block).toHaveClass(/copied/)

  await page.evaluate((id) => {
    window.__mock.updateEvent('s-alpha', id, {
      text: ['Run this:', '', '```', 'npm run check', '```', '', 'Then read the output.'].join('\n'),
      partial: true,
    })
  }, eventId)

  await expect(page.getByTestId('stream-event-assistant_text')).toContainText('Then read the output')
  await expect(
    page.getByTestId('stream-event-assistant_text').locator('pre.md-pre'),
  ).toHaveClass(/copied/)
})

test('selecting inside a code block is not overwritten by the copy', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.evaluate(async () => {
    window.__mock.emitEvent('s-alpha', 'assistant_text', {
      text: ['```', 'first line', 'second line', '```'].join('\n'),
      partial: false,
    })
    await navigator.clipboard.writeText('what the developer already copied')
  })

  const block = page.getByTestId('stream-event-assistant_text').locator('pre.md-pre')
  await page.evaluate(() => {
    const code = document.querySelector('pre.md-pre code')
    const range = document.createRange()
    range.selectNodeContents(code!)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
  })
  await block.click({ position: { x: 5, y: 5 } })

  await expect(block).not.toHaveClass(/copied/)
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    'what the developer already copied',
  )
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

async function emitBlock(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    window.__mock.emitEvent('s-alpha', 'assistant_text', {
      text: ['```ts', 'const timeout = input.timeout ?? 5_000', '```'].join('\n'),
      partial: false,
    })
  })
}

async function label(page: import('@playwright/test').Page): Promise<string> {
  return page
    .locator('pre.md-pre')
    .first()
    .evaluate((el) => getComputedStyle(el, '::after').content)
}

test('a copied code block says copied, in the neutral ink rather than the accent', async ({
  page,
}) => {
  await emitBlock(page)
  const pre = page.locator('pre.md-pre').first()
  await expect(pre).toBeVisible()

  expect(await label(page)).toContain('copy')

  await pre.click()
  await expect.poll(() => label(page)).toContain('copied')
  const state = await pre.evaluate((el) => {
    const cs = getComputedStyle(el, '::after')
    return { color: cs.color, weight: cs.fontWeight }
  })
  expect(state.weight).toBe('500')
  expect(state.color).not.toBe('rgb(63, 191, 180)') 
  expect(state.color).not.toBe('rgb(18, 118, 110)') 
})

test('a copy that fails says so, instead of saying nothing at all', async ({ page }) => {
  await page.evaluate(() => window.__mock.setClipboardFails(true))
  await emitBlock(page)
  const pre = page.locator('pre.md-pre').first()
  await expect(pre).toBeVisible()

  await pre.click()
  await expect.poll(() => label(page)).toContain('could not copy')
})
