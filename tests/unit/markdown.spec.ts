// Safe Markdown renderer for assistant responses in the clean view.
import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '@shared/markdown'

describe('renderMarkdown', () => {
  it('renders bold and inline code', () => {
    const html = renderMarkdown('**net: -20 lines** possible via `?? []`')
    expect(html).toContain('<strong>net: -20 lines</strong>')
    expect(html).toContain('<code>?? []</code>')
  })

  it('renders a fenced code block verbatim, without inline formatting inside', () => {
    const html = renderMarkdown('```\nyagni  fold `GetTokenAsync` **here**\n```')
    expect(html).toContain('<pre class="md-pre"><code>')
    // Markers inside the fence stay literal (no <strong>/<code> injected).
    expect(html).toContain('`GetTokenAsync`')
    expect(html).toContain('**here**')
    expect(html).not.toContain('<strong>')
  })

  it('escapes HTML to prevent injection', () => {
    const html = renderMarkdown('watch out <img src=x onerror=alert(1)> and </div>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
    expect(html).toContain('&lt;/div&gt;')
  })

  it('escapes HTML inside code spans and fences too', () => {
    expect(renderMarkdown('`<script>`')).toContain('<code>&lt;script&gt;</code>')
    expect(renderMarkdown('```\n<script>\n```')).toContain('&lt;script&gt;')
    expect(renderMarkdown('```\n<script>\n```')).not.toContain('<script>')
  })

  it('renders headings and lists', () => {
    const html = renderMarkdown('## Findings\n\n- first\n- second')
    expect(html).toContain('<h2>Findings</h2>')
    expect(html).toContain('<ul><li>first</li><li>second</li></ul>')
  })

  it('does not treat snake_case or arithmetic as emphasis', () => {
    const html = renderMarkdown('use file_path and compute 5 * 3 * 2')
    expect(html).not.toContain('<em>')
    expect(html).toContain('file_path')
  })

  it('cannot be tricked by a forged code-span sentinel', () => {
    // A literal NUL in the input must be stripped, not used to fabricate a span.
    const html = renderMarkdown(`${String.fromCharCode(0)}0${String.fromCharCode(0)} plain`)
    expect(html).toContain('0 plain')
  })
})
