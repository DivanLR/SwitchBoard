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
 * What Browse opens on, per command.
 *
 * `takesDiagram` above marks the commands whose file the section already knows —
 * it is the drawing in the pane, and `pickCommand` fills it in. These are the
 * other case: the file lives somewhere on the developer's machine and the only
 * way to name it was to type the whole path into the box. A native picker is the
 * answer, and it should open on the files the command can actually read rather
 * than on everything.
 *
 * Keyed by command, and lives in shared rather than in the view, so the main
 * process can validate a pick request against a closed set instead of taking
 * dialogue configuration from the renderer.
 *
 * Only the diagram-design commands are here. archify's subcommands are argv with
 * several positional slots (`deliver <type> <input.json> [output.html]`), and a
 * picker that guesses which slot a path belongs in would put it in the wrong one.
 */
export const DIAGRAM_FILE_PICKS = {
  'import-mermaid': {
    title: 'Choose a Mermaid file',
    name: 'Mermaid',
    extensions: ['mmd', 'mermaid', 'md', 'txt'],
  },
  'import-drawio': {
    title: 'Choose a draw.io file',
    name: 'draw.io',
    extensions: ['drawio', 'xml', 'svg', 'png'],
  },
  'export-diagram': {
    title: 'Choose a diagram HTML file',
    name: 'Diagram HTML',
    extensions: ['html', 'htm'],
  },
  /* The one the section's own Browse button opens: every source any of the three
     can read, in one dialogue, because at the point of clicking Browse the
     developer has a file in mind and not a command. `diagramCommandForFile`
     picks the command back out of what they chose.

     `png` and `svg` are in the list for `.drawio.png` and `.drawio.svg`, which a
     dialogue filter cannot express — a filter matches the last extension only.
     A bare image therefore passes the filter and is caught afterwards. */
  import: {
    title: 'Choose a diagram file to import',
    name: 'Diagram sources',
    extensions: ['mmd', 'mermaid', 'drawio', 'xml', 'html', 'htm', 'md', 'txt', 'png', 'svg'],
  },
  /* Deliberately the widest list here, and the only one that does not have to
     route to a command. archify READS this file rather than compiling it, so a
     whiteboard photograph, a README or an OpenAPI document are all legitimate
     source material, and narrowing the dialogue would refuse things the skill
     can plainly use. */
  'archify-reference': {
    title: 'Choose a file for archify to draw from',
    name: 'Reference material',
    extensions: [
      'drawio', 'mmd', 'mermaid', 'xml', 'json', 'yaml', 'yml',
      'md', 'txt', 'html', 'htm', 'pdf', 'png', 'jpg', 'jpeg', 'svg', 'webp',
    ],
  },
} as const

export type DiagramFilePick = keyof typeof DIAGRAM_FILE_PICKS

export function isDiagramFilePick(value: string): value is DiagramFilePick {
  return Object.prototype.hasOwnProperty.call(DIAGRAM_FILE_PICKS, value)
}

/**
 * Which command reads this file, from its name alone.
 *
 * Browse asks for a file, not for a command, so something has to choose the
 * command — and the extension is the only evidence there is at that moment. Null
 * means nothing here can read it, which the caller reports rather than swallows:
 * a Browse that quietly does nothing is worse than no Browse.
 *
 * `.drawio.png` and `.drawio.svg` are draw.io's own export formats and carry the
 * source inside them, so they import; a plain `.png` or `.svg` is an image and
 * does not. The two are told apart by the compound extension, which is why this
 * tests the whole name rather than the last dot.
 */
export function diagramCommandForFile(path: string): DiagramFilePick | null {
  const name = path.toLowerCase().replace(/^.*[\\/]/, '')
  if (/\.drawio(\.(png|svg|xml))?$/.test(name)) return 'import-drawio'
  if (/\.(mmd|mermaid)$/.test(name)) return 'import-mermaid'
  // draw.io's raw save format, and the one it offers as "Export as XML".
  if (/\.xml$/.test(name)) return 'import-drawio'
  // A Markdown or text file reaching here holds a fenced mermaid block; that is
  // the only diagram source either of those carries.
  if (/\.(md|txt)$/.test(name)) return 'import-mermaid'
  // Already a drawn diagram: the thing to do with it is export it to SVG or PNG.
  if (/\.(html|htm)$/.test(name)) return 'export-diagram'
  return null
}

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

// ── The second engine: archify ──────────────────────────────────────────────
//
// github.com/tt-a1i/archify is a SKILL, not a plugin, and that distinction is
// the whole reason it is worth having beside diagram-design. The agent authors a
// small typed JSON IR; archify's own Node CLI validates that IR against a schema
// and compiles it deterministically into standalone HTML. The drawing is
// therefore checked by a program rather than trusted to a model, and the same
// specification re-renders identically.
//
// It arrives through the app's OWN Skills importer (two HTTPS GETs, no shell, no
// archive extractor — see main/skills/import.ts) rather than through
// `plugins.install`, because `claude plugin` installs plugins and this is not
// one. Its skill folder is 190 files and 7.4 MB, inside that importer's caps.
export const ARCHIFY = {
  /** Its SKILL.md `name`, which is how a session addresses it and how this app
   *  recognises it in the imported-skills list. */
  skill: 'archify',
  /**
   * The folder inside the repository that holds the SKILL.md, not the repository
   * root. The root also carries docs/, benchmarks/ and experiments/, none of
   * which the skill needs and all of which the importer would download.
   */
  source: 'https://github.com/tt-a1i/archify/tree/main/archify',
  /** Where its CLI lands once the importer has written the skill. */
  bin: '~/.claude/skills/archify/bin/archify.mjs',
} as const

/**
 * archify's own type router, taken from its SKILL.md rather than paraphrased.
 *
 * This is what makes the archify path INTERACTIVE where the diagram-design path
 * is one sentence: archify commits to a type before it draws, the five types
 * produce genuinely different pictures, and a developer who already knows they
 * want a sequence diagram should not have to talk a model into one.
 */
export const ARCHIFY_TYPES = [
  {
    type: 'auto',
    label: 'Choose for me',
    hint: 'Runs archify guide first and takes the type it routes to',
  },
  {
    type: 'architecture',
    label: 'Architecture',
    hint: 'Components, services, cloud/security boundaries, infrastructure',
  },
  {
    type: 'workflow',
    label: 'Workflow',
    hint: 'Processes, approval gates, tool calls, runbooks, CI/CD',
  },
  {
    type: 'sequence',
    label: 'Sequence',
    hint: 'API call chains, request lifecycles, async traces, returns',
  },
  {
    type: 'dataflow',
    label: 'Data flow',
    hint: 'Pipelines, ETL/ELT, lineage, governance, consumers',
  },
  {
    type: 'lifecycle',
    label: 'Lifecycle',
    hint: 'State/status transitions, retries, waiting and terminal states',
  },
] as const

export type ArchifyType = (typeof ARCHIFY_TYPES)[number]['type']

/** What the interactive bar collects before it asks for a drawing. */
export interface ArchifyOptions {
  type: ArchifyType
  /** archify's `--quality`. `showcase` is the profile its own authoring path
   *  defaults to; `standard` is for a deliberately dense map. */
  quality: 'showcase' | 'standard'
  /**
   * The viewer extras: `meta.animation: "trace"` plus a few curated `meta.views`
   * chapters, so the delivered page can be stepped through rather than only read.
   * Off by default, which is the skill's own rule — it enables motion only when
   * the user asks for a demo or a presentation.
   */
  motion: boolean
  /**
   * A file on the developer's machine for the skill to draw FROM: an existing
   * `.drawio` or `.mmd`, a screenshot of a whiteboard, a spec, a README.
   *
   * The drawing flow had no way to say "like this one". Everything archify knew
   * came from one line of prose, so redrawing something that already existed
   * meant describing it from memory. Absent for an ordinary described diagram,
   * and per-drawing rather than a standing preference, for the same reason
   * `type` is: it is a fact about the ONE request being made.
   */
  reference?: string
}

export const DEFAULT_ARCHIFY: ArchifyOptions = {
  type: 'auto',
  quality: 'showcase',
  motion: false,
}

/**
 * archify's CLI, as its own `usage()` prints it.
 *
 * Every subcommand is here rather than the three this section would itself use,
 * because the menu's job is to say what the tool can do. `sendable: false` marks
 * the one that must never be dispatched to a background session: `preview`
 * starts a file watcher on a loopback port and returns only on Ctrl-C, so a
 * session sent it would sit there until something killed it. It is listed
 * anyway, with its own note, because pretending it does not exist is worse than
 * saying why it is not offered.
 */
export const ARCHIFY_COMMANDS = [
  {
    command: 'doctor',
    description: 'Check the archify install answers before anything depends on it',
    argumentHint: '',
    sendable: true,
  },
  {
    command: 'guide',
    description: 'Ask which diagram type fits a scenario, and why',
    argumentHint: '[scenario or question] [--json] [--lang en|zh]',
    sendable: true,
  },
  {
    command: 'validate',
    description: 'Check one specification against its schema and the composition rules',
    argumentHint:
      '<type> <input.json> [--json] [--layout-json] [--quality …] [--repo-root path (architecture only)]',
    sendable: true,
  },
  {
    command: 'deliver',
    description: 'Final acceptance: freeze the specification, render it, commit the HTML',
    argumentHint: '<type> <input.json> [output.html] [--json] [--open] [--quality …]',
    sendable: true,
  },
  {
    command: 'render',
    description: 'Compile a specification straight to HTML, without the delivery receipt',
    argumentHint:
      '<type> <input.json> [output.html] [--quality …] [--repo-root path (architecture only)]',
    sendable: true,
  },
  {
    command: 'visual-check',
    description: 'Measure containment at four desktop sizes, capture light and dark shots',
    argumentHint: '<output.html> [--json]',
    sendable: true,
  },
  {
    command: 'check',
    description: 'Verify one delivered HTML file is intact',
    argumentHint: '<output.html>',
    sendable: true,
  },
  {
    command: 'compare',
    description: 'Draw the delta between two architecture specifications',
    argumentHint:
      'architecture <base.json> <head.json> [output.html] [--receipt path] [--json] [--quality …] [--repo-root path]',
    sendable: true,
  },
  {
    command: 'inspect',
    description: 'Print what the compiler reads out of a specification',
    argumentHint: '<type> <input.json>',
    sendable: true,
  },
  {
    command: 'migrate',
    description: 'Move a workflow specification onto schema v2',
    argumentHint: 'workflow <old.json> <new.json> --to-schema 2 [--json]',
    sendable: true,
  },
  {
    command: 'brands',
    description: 'Look up a real product mark, or capture one from its official URL',
    argumentHint: '[name|alias|domain|category] [--json] · capture <url> [--json]',
    sendable: true,
  },
  {
    // It renders, it does not list. commandExamples() shells straight out to
    // scripts/render-examples.mjs, which re-renders the five bundled
    // specifications over the checked-in *-rendered.html files in the skill's
    // own examples/ folder. Naming it "list" would invite someone to run it
    // expecting a read-only menu of names.
    command: 'examples',
    description: 'Re-render the bundled example specifications, in the skill’s own folder',
    argumentHint: '',
    sendable: true,
  },
  {
    // One file, one type: commandDemo() renders examples/web-app.architecture.json
    // to a single archify-demo.html. Not a set, and not a choice of type.
    command: 'demo',
    description: 'Write one rendered architecture example (archify-demo.html) into a directory',
    argumentHint: '[output-directory]',
    sendable: true,
  },
  {
    command: 'preview',
    description: 'Watch one specification and re-render it live — runs until Ctrl-C',
    argumentHint: '<type> <input.json> [output.html] [--no-open] [--quality …]',
    sendable: false,
  },
] as const

/** The prefix that makes the section's one field an archify command rather than
 *  a description, the way a leading `/` marks a plugin command. */
export const ARCHIFY_PREFIX = 'archify '

/**
 * An archify CLI command, told where this section looks and how to reach the bin.
 *
 * Same reasoning as diagramCommandText: what the developer typed is theirs, so
 * this appends rather than rewrites. It adds the two facts the session cannot
 * know — that the CLI lives inside the imported skill, and that only
 * `docs/diagrams` is listed — and asks for the exit status, because archify's own
 * contract is that a non-zero exit can never be reported as success.
 */
export function archifyCommandText(typed: string): string {
  const argv = typed.trim().replace(/^archify\s+/i, '')
  return [
    'Run this archify command and report exactly what it prints, including a',
    'non-zero exit status. Do not describe a failed command as a success.',
    '',
    `    node ${ARCHIFY.bin} ${argv}`,
    '',
    `If that path does not exist, find the archify skill's own bin/archify.mjs and`,
    'use it instead; the skill ships the CLI alongside its schemas.',
    '',
    `Write any diagram file it produces into ${DIAGRAMS_DIR}/, creating that folder`,
    'if it does not exist. It is the only folder this application lists diagrams',
    'from, so a file written anywhere else will not appear.',
  ].join('\n')
}

/** The specification that sits beside a delivered diagram, named the way
 *  archify's own examples are: `<base>.<type>.json`. */
export function archifySpecFile(file: string, type: ArchifyType): string {
  const base = file.replace(/\.html$/, '')
  return type === 'auto' ? `${base}.<type>.json` : `${base}.${type}.json`
}

/**
 * What an archify drawing session is actually asked.
 *
 * Deliberately not diagramPrompt with a different skill name in it. archify's
 * value is its pipeline — author typed JSON, validate it against a schema,
 * deliver — and a prompt that only said "use archify" would return a model's
 * idea of a diagram with an archify label on it. So the three steps are named,
 * the receipt is asked for, and the failure rule is stated.
 *
 * Four things it must say that are not obvious:
 * - NEVER `preview`. It watches a file on a loopback port and returns only on
 *   Ctrl-C. This runs in a BACKGROUND session with nobody at the keyboard, so a
 *   preview would hold that session open until it was killed, and the section
 *   would show "drawing…" for twenty minutes and then blame its own deadline.
 * - The exact output path, for the reason diagramPrompt gives it: this section
 *   reads one folder and nothing else.
 * - The failure rule. A failed delivery deliberately LEAVES THE PREVIOUS OUTPUT
 *   in place, so a session that ignored the exit status would report a stale
 *   file as the new drawing, and the app cannot tell the difference from a file
 *   listing.
 * - The same SWB_DIAGRAM plan line the other engine prints, mapped onto
 *   archify's vocabulary, so the section's plan strip reads either engine.
 */
export function archifyPrompt(description: string, file: string, options: ArchifyOptions): string {
  const spec = `${DIAGRAMS_DIR}/${archifySpecFile(file, options.type)}`
  const out = `${DIAGRAMS_DIR}/${file}`
  // Quotes are swapped rather than escaped: this lands inside a shell example in
  // the prompt, and a description holding a double quote would end the argument.
  const quoted = description.replace(/"/g, "'")
  const type = options.type === 'auto' ? '<type>' : options.type

  return [
    `Create a diagram: ${description}`,
    '',
    // Before the skill instructions, not after: the reference changes what is
    // being drawn, so it has to be read before any of the authoring starts. The
    // path is quoted because it comes from a native picker and Windows paths
    // carry spaces.
    ...(options.reference
      ? [
          `Draw it FROM this file, which the developer chose as the reference:`,
          `    "${options.reference}"`,
          'Read it first. Carry over its actual nodes, edges, labels and grouping',
          'rather than inventing a fresh diagram that merely matches the sentence',
          'above; that sentence says what to make of the file, not what to invent.',
          'If it is an image, read what it depicts. If the file cannot be read, say',
          'so and stop rather than drawing from the sentence alone.',
          '',
        ]
      : []),
    `Use the ${ARCHIFY.skill} skill for this, and follow its own fast authoring path:`,
    'read the one matching schema and the one matching example, author fresh typed',
    'JSON with your own stable IDs and wording, then validate and deliver it.',
    '',
    ...(options.type === 'auto'
      ? [
          'Choose the type yourself from architecture, workflow, sequence, dataflow or',
          'lifecycle. If the request is genuinely ambiguous, ask archify first:',
          `    node ${ARCHIFY.bin} guide "${quoted}" --json`,
          'and take the type it routes to.',
        ]
      : [`Use the ${options.type} type. Do not substitute another one.`]),
    '',
    `1. Write the specification to ${spec}, creating the folder if it does not exist.`,
    `   Set meta.quality_profile to "${options.quality}".`,
    ...(options.motion
      ? [
          '   Turn the viewer extras on: set meta.animation to "trace", and add at most',
          '   five curated meta.views chapters so it can be stepped through.',
        ]
      : ['   Leave motion off: no meta.animation and no meta.views. Static is the default.']),
    '',
    '2. Validate, and repair only what the receipt actually diagnoses:',
    `       node ${ARCHIFY.bin} validate ${type} ${spec} --quality ${options.quality} --json`,
    ...(options.quality === 'showcase'
      ? [
          '   A showcase pass reports all 9 artifact checks with 0 composition errors and',
          '   0 warnings. A receipt with only 4 checks is basic validation, not a pass.',
        ]
      : ['   Fix every composition error the receipt names before going on.']),
    '',
    '3. Deliver only once it validates clean:',
    `       node ${ARCHIFY.bin} deliver ${type} ${spec} ${out} --quality ${options.quality} --json`,
    '',
    `If ${ARCHIFY.bin} does not exist, find the archify skill's own bin/archify.mjs`,
    'and use that instead.',
    '',
    'NEVER run `archify preview`. It watches the file on a loopback port and returns',
    'only on Ctrl-C, and nobody is at this keyboard: it would hold this session open',
    'until something killed it. Use validate and deliver.',
    '',
    'A non-zero exit is a failure and must never be reported as success. A failed',
    'delivery leaves the previous output in place, so do not describe an older file',
    'as the new drawing.',
    '',
    // Same sentinel, same reader (parseDiagramPlan), archify's vocabulary in the
    // fields. Printed BEFORE the work, so a run that dies mid-render still leaves
    // what it intended to draw.
    'Before you draw, print one line on its own starting with',
    `${DIAGRAM_PLAN_MARKER}: followed by JSON (one line, no code fence):`,
    '{"type": "<the archify type you used>", "pattern": "<the visual preset, or null>",',
    `"size": "${options.quality}", "cuts": ["<anything you left out to keep it readable>"]}`,
    'Then draw it.',
    '',
    `When it is delivered, reply with the one line: wrote ${out}`,
  ].join('\n')
}
