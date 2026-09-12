import { describe, expect, it } from 'vitest'
import { DIAGRAM_FILE_PICKS, diagramCommandForFile, isDiagramFilePick } from '@shared/diagram'

describe('diagramCommandForFile', () => {
  it('routes draw.io sources to the draw.io importer', () => {
    expect(diagramCommandForFile('C:\\work\\arch.drawio')).toBe('import-drawio')
    expect(diagramCommandForFile('C:\\work\\arch.drawio.png')).toBe('import-drawio')
    expect(diagramCommandForFile('C:\\work\\arch.drawio.svg')).toBe('import-drawio')
    expect(diagramCommandForFile('/home/d/arch.drawio.xml')).toBe('import-drawio')
    expect(diagramCommandForFile('/home/d/arch.xml')).toBe('import-drawio')
  })

  it('routes Mermaid sources, including the files that carry a fenced block', () => {
    expect(diagramCommandForFile('C:\\work\\flow.mmd')).toBe('import-mermaid')
    expect(diagramCommandForFile('C:\\work\\flow.mermaid')).toBe('import-mermaid')
    expect(diagramCommandForFile('C:\\work\\notes.md')).toBe('import-mermaid')
    expect(diagramCommandForFile('C:\\work\\notes.txt')).toBe('import-mermaid')
  })

  it('treats an HTML diagram as something to export, not to import', () => {
    expect(diagramCommandForFile('C:\\work\\auth-flow.html')).toBe('export-diagram')
    expect(diagramCommandForFile('C:\\work\\auth-flow.htm')).toBe('export-diagram')
  })

  it('refuses a plain image, which the picker cannot filter out', () => {
    expect(diagramCommandForFile('C:\\Users\\d\\Desktop\\screenshot.png')).toBeNull()
    expect(diagramCommandForFile('C:\\Users\\d\\Desktop\\logo.svg')).toBeNull()
    expect(diagramCommandForFile('C:\\Users\\d\\Desktop\\report.pdf')).toBeNull()
    expect(diagramCommandForFile('C:\\Users\\d\\Desktop\\no-extension')).toBeNull()
  })

  it('reads the file name, not the folders above it', () => {
    expect(diagramCommandForFile('C:\\work\\diagrams.drawio\\shot.png')).toBeNull()
    expect(diagramCommandForFile('C:\\my.mmd.folder\\arch.drawio')).toBe('import-drawio')
  })

  it('is case-insensitive, because Windows is', () => {
    expect(diagramCommandForFile('C:\\work\\ARCH.DRAWIO')).toBe('import-drawio')
    expect(diagramCommandForFile('C:\\work\\Flow.MMD')).toBe('import-mermaid')
  })

  it('only returns keys the file-pick table knows', () => {
    const returned = [
      diagramCommandForFile('a.drawio'),
      diagramCommandForFile('a.mmd'),
      diagramCommandForFile('a.html'),
    ]
    for (const command of returned) {
      expect(command).not.toBeNull()
      expect(isDiagramFilePick(command!)).toBe(true)
    }
  })

  it('offers a filter for every extension the mapping accepts', () => {
    const offered = DIAGRAM_FILE_PICKS.import.extensions as readonly string[]
    for (const ext of ['mmd', 'mermaid', 'drawio', 'xml', 'html', 'htm', 'md', 'txt']) {
      expect(offered, `.${ext} is routable but not offered`).toContain(ext)
      expect(diagramCommandForFile(`x.${ext}`)).not.toBeNull()
    }
    expect(offered).toContain('png')
    expect(offered).toContain('svg')
  })
})
