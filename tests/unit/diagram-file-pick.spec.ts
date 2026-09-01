// diagramCommandForFile is what the Diagrams section's Browse button stands on:
// the developer picks a file, not a command, so the extension is the only
// evidence there is about which of the three commands can read it. Getting it
// wrong sends a draw.io export to the Mermaid importer, which fails deep inside
// a background session rather than at the click.
import { describe, expect, it } from 'vitest'
import { DIAGRAM_FILE_PICKS, diagramCommandForFile, isDiagramFilePick } from '@shared/diagram'

describe('diagramCommandForFile', () => {
  it('routes draw.io sources to the draw.io importer', () => {
    expect(diagramCommandForFile('C:\\work\\arch.drawio')).toBe('import-drawio')
    // draw.io's own export formats carry the source inside them, so they import
    // rather than being treated as the images their extension claims.
    expect(diagramCommandForFile('C:\\work\\arch.drawio.png')).toBe('import-drawio')
    expect(diagramCommandForFile('C:\\work\\arch.drawio.svg')).toBe('import-drawio')
    expect(diagramCommandForFile('/home/d/arch.drawio.xml')).toBe('import-drawio')
    // Raw XML is draw.io's save format and its "Export as XML".
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

  // The whole reason the function exists rather than a last-dot lookup. The
  // picker must allow bare png and svg so that `.drawio.png` can be selected at
  // all, so a plain image WILL reach here and has to be refused.
  it('refuses a plain image, which the picker cannot filter out', () => {
    expect(diagramCommandForFile('C:\\Users\\d\\Desktop\\screenshot.png')).toBeNull()
    expect(diagramCommandForFile('C:\\Users\\d\\Desktop\\logo.svg')).toBeNull()
    expect(diagramCommandForFile('C:\\Users\\d\\Desktop\\report.pdf')).toBeNull()
    expect(diagramCommandForFile('C:\\Users\\d\\Desktop\\no-extension')).toBeNull()
  })

  it('reads the file name, not the folders above it', () => {
    // A folder called "diagrams.drawio" must not decide the command for the
    // ordinary png sitting inside it.
    expect(diagramCommandForFile('C:\\work\\diagrams.drawio\\shot.png')).toBeNull()
    expect(diagramCommandForFile('C:\\my.mmd.folder\\arch.drawio')).toBe('import-drawio')
  })

  it('is case-insensitive, because Windows is', () => {
    expect(diagramCommandForFile('C:\\work\\ARCH.DRAWIO')).toBe('import-drawio')
    expect(diagramCommandForFile('C:\\work\\Flow.MMD')).toBe('import-mermaid')
  })

  // Every command this can return has to be a key main will accept, or Browse
  // writes a command line the picker itself would refuse to open next time.
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

  // The import dialogue has to offer every extension the mapping can route, or a
  // file the section can read cannot be selected in the first place.
  it('offers a filter for every extension the mapping accepts', () => {
    const offered = DIAGRAM_FILE_PICKS.import.extensions as readonly string[]
    for (const ext of ['mmd', 'mermaid', 'drawio', 'xml', 'html', 'htm', 'md', 'txt']) {
      expect(offered, `.${ext} is routable but not offered`).toContain(ext)
      expect(diagramCommandForFile(`x.${ext}`)).not.toBeNull()
    }
    // These two are offered ONLY so `.drawio.png` and `.drawio.svg` can be
    // reached; on their own they are correctly refused.
    expect(offered).toContain('png')
    expect(offered).toContain('svg')
  })
})
