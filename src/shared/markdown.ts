const SENTINEL = String.fromCharCode(0)
const RESTORE = new RegExp(`${SENTINEL}(\\d+)${SENTINEL}`, 'g')

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function renderInline(escaped: string): string {
  const codeSpans: string[] = []
  let out = escaped.replace(/`([^`]+)`/g, (_match, code: string) => {
    codeSpans.push(code)
    return `${SENTINEL}${codeSpans.length - 1}${SENTINEL}`
  })
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/\*(?!\s)([^*\n]+?)(?<!\s)\*/g, '<em>$1</em>')
  out = out.replace(RESTORE, (_match, index: string) => `<code>${codeSpans[Number(index)]}</code>`)
  return out
}

const TABLE_SEPARATOR = /^:?-{3,}:?$/

function tableCells(row: string): string[] {
  return row
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())
}

function renderBlocks(text: string): string {
  const inline = (raw: string): string => renderInline(escapeHtml(raw))
  const lines = text.split('\n')
  let html = ''
  let paragraph: string[] = []
  let listType: 'ul' | 'ol' | null = null
  let listItems: string[] = []
  let tableRows: string[] = []

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    html += `<p>${inline(paragraph.join(' '))}</p>`
    paragraph = []
  }
  const flushList = (): void => {
    if (listItems.length === 0) return
    html += `<${listType}>${listItems.map((li) => `<li>${inline(li)}</li>`).join('')}</${listType}>`
    listItems = []
    listType = null
  }
  const flushTable = (): void => {
    if (tableRows.length === 0) return
    const rows = tableRows.map(tableCells)
    tableRows = []
    const hasHeader = rows.length > 1 && rows[1].every((c) => TABLE_SEPARATOR.test(c))
    const cellsToRow = (cells: string[], tag: 'th' | 'td'): string =>
      `<tr>${cells.map((c) => `<${tag}>${inline(c)}</${tag}>`).join('')}</tr>`
    const head = hasHeader ? `<thead>${cellsToRow(rows[0], 'th')}</thead>` : ''
    const body = (hasHeader ? rows.slice(2) : rows).map((r) => cellsToRow(r, 'td')).join('')
    html += `<div class="md-table-wrap"><table class="md-table">${head}<tbody>${body}</tbody></table></div>`
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (/^\|.*\|$/.test(trimmed)) {
      flushParagraph()
      flushList()
      tableRows.push(trimmed)
      continue
    }
    flushTable()
    if (trimmed === '') {
      flushParagraph()
      flushList()
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed)
    if (heading) {
      flushParagraph()
      flushList()
      const level = heading[1].length
      html += `<h${level}>${inline(heading[2])}</h${level}>`
      continue
    }
    const bullet = /^[-*]\s+(.*)$/.exec(trimmed)
    if (bullet) {
      flushParagraph()
      if (listType && listType !== 'ul') flushList()
      listType = 'ul'
      listItems.push(bullet[1])
      continue
    }
    const ordered = /^\d+\.\s+(.*)$/.exec(trimmed)
    if (ordered) {
      flushParagraph()
      if (listType && listType !== 'ol') flushList()
      listType = 'ol'
      listItems.push(ordered[1])
      continue
    }
    flushList()
    paragraph.push(trimmed)
  }
  flushParagraph()
  flushList()
  flushTable()
  return html
}

export function renderMarkdown(source: string): string {
  const src = source.split(SENTINEL).join('')
  const fence = /```[^\n]*\n([\s\S]*?)```/g
  let html = ''
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = fence.exec(src)) !== null) {
    html += renderBlocks(src.slice(lastIndex, match.index))
    const code = match[1].replace(/\n$/, '')
    html += `<pre class="md-pre"><code>${escapeHtml(code)}</code></pre>`
    lastIndex = fence.lastIndex
  }
  html += renderBlocks(src.slice(lastIndex))
  return html
}
