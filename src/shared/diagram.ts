// Diagrams section: the naming and prompt rules shared by the main process, the
// renderer and the tests, so all three agree on where a diagram lands and what
// the session was asked to produce.
//
// Generation is done by the `diagram-design` Claude Code plugin
// (github.com/cathrynlavery/diagram-design), which runs INSIDE the project's
// session and writes a standalone HTML file with inline SVG. The plugin has no
// slash command for generating; it activates on an ordinary request. So the app
// does not call a library here: it names the file, asks the session for it, and
// then reads the folder back off disk.

/** Project-relative, forward slashes: the folder every diagram is written to. */
export const DIAGRAMS_DIR = 'docs/diagrams'

/** The plugin's own marketplace and package, run as two slash commands in order. */
// Plain identifiers, as the `claude plugin` subcommands take them. These were
// `/plugin …` slash commands sent to a session as chat, which an Agent SDK
// session answers with "/plugin isn't available in this environment", so the
// install could never run. See main/sessions/plugin-install.ts.
export const DIAGRAM_PLUGIN = {
  /** Marketplace source for `claude plugin marketplace add`. */
  marketplace: 'cathrynlavery/diagram-design',
  /** Package id for `claude plugin install`. */
  pkg: 'diagram-design@diagram-design',
  /**
   * A command the plugin ships. Its presence in a session's command list is how
   * the app knows the plugin is installed; the skill itself registers no command,
   * so there is nothing else to detect it by.
   */
  probeCommand: 'export-diagram',
  /** How this plugin's commands are namespaced in a session's command list. */
  namespace: 'diagram-design',
} as const

/**
 * The commands the plugin ships, for the section's Commands menu.
 *
 * Descriptions and argument hints are the plugin's OWN, read from its command
 * files rather than written here, so the menu says what the command does
 * instead of what this app guesses it does.
 *
 * Every one of them takes a file. `takesDiagram` marks the ones whose file is a
 * diagram this section already knows about — those can run on the one in the
 * pane without the developer typing a path.
 */
export const DIAGRAM_COMMANDS = [
  {
    command: 'export-diagram',
    description: 'Export a diagram HTML file to .svg and .png next to the source',
    argumentHint: '<html-file> [--svg-only|--png-only] [--scale=N]',
    takesDiagram: true,
  },
  {
    command: 'import-mermaid',
    description: 'Redraw Mermaid as an editorial diagram at a chosen format, size and detail level',
    argumentHint: '<mermaid-file> [--format=…] [--detail=…] [--audience=…]',
    takesDiagram: false,
  },
  {
    command: 'import-drawio',
    description: 'Redraw a draw.io file as an editorial diagram at a chosen format, size and detail level',
    argumentHint: '<drawio-file> [--format=…] [--detail=…] [--audience=…]',
    takesDiagram: false,
  },
] as const

/**
 * A filename the app chooses, rather than one the model invents.
 *
 * The app has to know the name in advance: it is what lets a finished file be
 * matched back to the session and the sentence that asked for it. Left to the
 * skill, the name is "inferred from diagram type and variant", which is neither
 * predictable nor unique.
 */
export function diagramFileName(description: string, taken: readonly string[] = []): string {
  const slug =
    description
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .split('-')
      .filter(Boolean)
      .slice(0, 6)
      .join('-') || 'diagram'
  const used = new Set(taken)
  if (!used.has(`${slug}.html`)) return `${slug}.html`
  // A second diagram of the same thing is a revision, not an overwrite.
  for (let n = 2; n < 1000; n++) {
    const candidate = `${slug}-${n}.html`
    if (!used.has(candidate)) return candidate
  }
  return `${slug}-${Date.now()}.html`
}

/**
 * What the session is actually asked.
 *
 * Four things it must say, each for a reason:
 * - The exact output path, because the skill's own default is the workspace root
 *   and the destination is the whole point of the feature.
 * - To use the default skin, because the skill has a first-run gate that asks the
 *   user to supply a website to take brand colours from. Left alone it would stop
 *   and ask, and a section whose one button hangs on a question is broken.
 * - That the deliverable is a DIAGRAM. Left to itself the model writes an
 *   editorial document around the drawing: a lede paragraph, a stat strip, then
 *   the picture, then numbered walkthroughs, resource tables and a reading
 *   order. It answers the question, at the length of a report, and the drawing
 *   ends up as one illustration inside an essay nobody asked for. A legend and
 *   one caption line are the whole of the prose budget.
 * - To answer with the path, so the reply names what it produced rather than
 *   leaving the developer to guess which of several files is new.
 */
export function diagramPrompt(description: string, file: string): string {
  return [
    `Create a diagram: ${description}`,
    '',
    `Save it to ${DIAGRAMS_DIR}/${file}, creating the folder if it does not exist.`,
    'Use the default editorial skin. Do not ask about brand colours, fonts or a',
    'website to sample; generate the diagram now with the neutral defaults.',
    'Choose the diagram type that fits the request.',
    '',
    'A DIAGRAM, not a document. The page is a short title, the drawing, and a',
    'legend. Every label belongs inside the drawing. Do not add an introductory',
    'paragraph above it, and do not add prose sections, resource tables, numbered',
    'walkthroughs or a reading order below it. One caption line under the drawing',
    'is the whole of the prose budget; if something needs explaining, label it in',
    'the picture instead.',
    '',
    `When it is written, reply with the one line: wrote ${DIAGRAMS_DIR}/${file}`,
  ].join('\n')
}
