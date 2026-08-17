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

/**
 * What the session decided before it drew.
 *
 * The skill's own rule (its §3, "Confirm before drawing") is to state the chosen
 * visual type, the semantic pattern where one is routed, the size preset, and
 * anything the complexity budget forces out. That message is the most useful
 * sentence in the whole transcript for judging a drawing — it says what the
 * picture was TRYING to be — and it was scrolling past in the session log while
 * the section showed only a file name.
 *
 * Every field is optional because this is a record of what was said, not a
 * demand. A skill that omits the pattern has not failed; it has drawn something
 * with no pattern to name.
 */
export interface DiagramPlan {
  /** Chosen visual type, e.g. `flow`, `matrix`, `timeline`. */
  type: string | null
  /** Semantic pattern, where the skill routed to one. */
  pattern: string | null
  /** Size preset, e.g. `doc-inline`, `slide-16x9`, `print-a4-landscape`. */
  size: string | null
  /** What the complexity budget forced out, in the skill's own words. */
  cuts: string[]
}

/** Sentinel for the plan line, matching the SWB_ convention used by verify runs. */
export const DIAGRAM_PLAN_MARKER = 'SWB_DIAGRAM'

/**
 * Read a plan out of session text, tolerantly: anything unreadable is no plan
 * rather than a half-filled one. The LAST marker wins, because the prompt names
 * the sentinel and a turn may restate it.
 */
export function parseDiagramPlan(text: string): DiagramPlan | null {
  const at = text.lastIndexOf(`${DIAGRAM_PLAN_MARKER}:`)
  if (at === -1) return null
  const tail = text.slice(at + DIAGRAM_PLAN_MARKER.length + 1)
  const start = tail.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let end = -1
  for (let i = start; i < tail.length; i++) {
    if (tail[i] === '{') depth++
    else if (tail[i] === '}' && --depth === 0) {
      end = i + 1
      break
    }
  }
  if (end === -1) return null
  let raw: unknown
  try {
    raw = JSON.parse(tail.slice(start, end))
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
  const plan: DiagramPlan = {
    type: str(record.type),
    pattern: str(record.pattern),
    size: str(record.size),
    cuts: Array.isArray(record.cuts)
      ? record.cuts.map(str).filter((c): c is string => c !== null)
      : [],
  }
  // A plan that says nothing is not a plan. Recording it would put an empty strip
  // above every diagram drawn by a version of the skill that does not announce.
  return plan.type || plan.pattern || plan.size || plan.cuts.length > 0 ? plan : null
}

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
/**
 * A plugin command from the Diagrams tab, told where this section actually looks.
 *
 * The Generate button goes through diagramPrompt, which names the folder in its
 * first instruction. A command typed or picked from the Commands menu was sent
 * verbatim instead, so the plugin used its own default — `docs/` — and the file
 * landed one directory above the only folder `diagrams.list` reads. The section
 * then showed nothing, for a drawing that had been written perfectly well.
 *
 * Confirmed rather than assumed: two real files, bundles-worker-architecture and
 * bundles-worker-steps, sit in a project's `docs/` today with no `docs/diagrams`
 * beside them, both produced by `/diagram-design:export-diagram`.
 *
 * Appended rather than injected into the command itself, because what the
 * developer typed is theirs and the plugin parses its own arguments: this adds a
 * sentence after it, exactly as a person would.
 */
export function diagramCommandText(typed: string): string {
  return (
    `${typed}\n\n` +
    `Write any diagram file you create or export into ${DIAGRAMS_DIR}/, creating ` +
    'that folder if it does not exist. It is the only folder this application ' +
    'lists diagrams from, so a file written anywhere else will not appear.'
  )
}

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
    // The skill already decides these and states them before drawing; this only
    // asks for the same facts in a shape the section can keep. Asked for BEFORE
    // the drawing so a run that dies mid-render still leaves what it intended.
    'Before you draw, print one line on its own starting with',
    `${DIAGRAM_PLAN_MARKER}: followed by JSON (one line, no code fence):`,
    '{"type": "<the visual type you chose>", "pattern": "<the semantic pattern, or',
    'null>", "size": "<the size preset>", "cuts": ["<anything the complexity budget',
    'forced out>"]}',
    'Then draw it.',
    '',
    `When it is written, reply with the one line: wrote ${DIAGRAMS_DIR}/${file}`,
  ].join('\n')
}
