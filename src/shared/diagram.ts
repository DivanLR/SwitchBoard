export const DIAGRAMS_DIR = 'docs/diagrams'

export interface DiagramPlan {
  type: string | null
  pattern: string | null
  size: string | null
  cuts: string[]
}

export const DIAGRAM_PLAN_MARKER = 'SWB_DIAGRAM'

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
  return plan.type || plan.pattern || plan.size || plan.cuts.length > 0 ? plan : null
}

export const DIAGRAM_PLUGIN = {
  marketplace: 'cathrynlavery/diagram-design',
  pkg: 'diagram-design@diagram-design',
  probeCommand: 'export-diagram',
  namespace: 'diagram-design',
} as const

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
  import: {
    title: 'Choose a diagram file to import',
    name: 'Diagram sources',
    extensions: ['mmd', 'mermaid', 'drawio', 'xml', 'html', 'htm', 'md', 'txt', 'png', 'svg'],
  },
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

export function diagramCommandForFile(path: string): DiagramFilePick | null {
  const name = path.toLowerCase().replace(/^.*[\\/]/, '')
  if (/\.drawio(\.(png|svg|xml))?$/.test(name)) return 'import-drawio'
  if (/\.(mmd|mermaid)$/.test(name)) return 'import-mermaid'
  if (/\.xml$/.test(name)) return 'import-drawio'
  if (/\.(md|txt)$/.test(name)) return 'import-mermaid'
  if (/\.(html|htm)$/.test(name)) return 'export-diagram'
  return null
}

export function diagramFileName(
  description: string,
  taken: readonly string[] = [],
  words = 6,
): string {
  const slug =
    description
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .split('-')
      .filter(Boolean)
      .slice(0, words)
      .join('-') || 'diagram'
  const used = new Set(taken)
  if (!used.has(`${slug}.html`)) return `${slug}.html`
  for (let n = 2; n < 1000; n++) {
    const candidate = `${slug}-${n}.html`
    if (!used.has(candidate)) return candidate
  }
  return `${slug}-${Date.now()}.html`
}

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

export const ARCHIFY = {
  skill: 'archify',
  source: 'https://github.com/tt-a1i/archify/tree/main/archify',
  bin: '~/.claude/skills/archify/bin/archify.mjs',
} as const

export const ARCHIFY_TYPES = [
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

export interface ArchifyOptions {
  type: ArchifyType
  quality: 'showcase' | 'standard'
  motion: boolean
  reference?: string
}

export const DEFAULT_ARCHIFY: ArchifyOptions = {
  type: 'architecture',
  quality: 'showcase',
  motion: false,
}

export const ARCHIFY_STAGES = [
  { stage: 'before', label: 'Before you draw' },
  { stage: 'author', label: 'Author and check the specification' },
  { stage: 'deliver', label: 'Deliver' },
  { stage: 'verify', label: 'Verify what was delivered' },
] as const

export type ArchifyStage = (typeof ARCHIFY_STAGES)[number]['stage']

export const ARCHIFY_COMMANDS = [
  {
    command: 'doctor',
    stage: 'before',
    description: 'Check the archify install answers before anything depends on it',
    argumentHint: '',
    sendable: true,
  },
  {
    command: 'guide',
    stage: 'before',
    description: 'Ask which diagram type fits a scenario, and why',
    argumentHint: '[scenario or question] [--json] [--lang en|zh]',
    sendable: true,
  },
  {
    command: 'validate',
    stage: 'author',
    description: 'Check one specification against its schema and the composition rules',
    argumentHint:
      '<type> <input.json> [--json] [--layout-json] [--quality …] [--repo-root path (architecture only)]',
    sendable: true,
  },
  {
    command: 'deliver',
    stage: 'deliver',
    description: 'Final acceptance: freeze the specification, render it, commit the HTML',
    argumentHint: '<type> <input.json> [output.html] [--json] [--open] [--quality …]',
    sendable: true,
  },
  {
    command: 'render',
    stage: 'deliver',
    description: 'Compile a specification straight to HTML, without the delivery receipt',
    argumentHint:
      '<type> <input.json> [output.html] [--quality …] [--repo-root path (architecture only)]',
    sendable: true,
  },
  {
    command: 'visual-check',
    stage: 'verify',
    description: 'Measure containment at four desktop sizes, capture light and dark shots',
    argumentHint: '<output.html> [--json]',
    sendable: true,
  },
  {
    command: 'check',
    stage: 'verify',
    description: 'Verify one delivered HTML file is intact',
    argumentHint: '<output.html>',
    sendable: true,
  },
  {
    command: 'compare',
    stage: 'verify',
    description: 'Draw the delta between two architecture specifications',
    argumentHint:
      'architecture <base.json> <head.json> [output.html] [--receipt path] [--json] [--quality …] [--repo-root path]',
    sendable: true,
  },
  {
    command: 'inspect',
    stage: 'author',
    description: 'Print what the compiler reads out of a specification',
    argumentHint: '<type> <input.json>',
    sendable: true,
  },
  {
    command: 'migrate',
    stage: 'author',
    description: 'Move a workflow specification onto schema v2',
    argumentHint: 'workflow <old.json> <new.json> --to-schema 2 [--json]',
    sendable: true,
  },
  {
    command: 'brands',
    stage: 'before',
    description: 'Look up a real product mark, or capture one from its official URL',
    argumentHint: '[name|alias|domain|category] [--json] · capture <url> [--json]',
    sendable: true,
  },
  {
    command: 'examples',
    stage: 'before',
    description: 'Re-render the bundled example specifications, in the skill’s own folder',
    argumentHint: '',
    sendable: true,
  },
  {
    command: 'demo',
    stage: 'before',
    description: 'Write one rendered architecture example (archify-demo.html) into a directory',
    argumentHint: '[output-directory]',
    sendable: true,
  },
  {
    command: 'preview',
    stage: 'deliver',
    description: 'Watch one specification and re-render it live — runs until Ctrl-C',
    argumentHint: '<type> <input.json> [output.html] [--no-open] [--quality …]',
    sendable: false,
  },
] as const

export const ARCHIFY_PREFIX = 'archify '

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

export function archifySpecFile(file: string, type: ArchifyType): string {
  const base = file.replace(/\.html$/, '')
  return `${base}.${type}.json`
}

export function archifyPrompt(description: string, file: string, options: ArchifyOptions): string {
  const spec = `${DIAGRAMS_DIR}/${archifySpecFile(file, options.type)}`
  const out = `${DIAGRAMS_DIR}/${file}`
  const type = options.type

  return [
    `Create a diagram: ${description}`,
    '',
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
    `Use the ${options.type} type. Do not substitute another one.`,
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
    'Before you draw, print one line on its own starting with',
    `${DIAGRAM_PLAN_MARKER}: followed by JSON (one line, no code fence):`,
    '{"type": "<the archify type you used>", "pattern": "<the visual preset, or null>",',
    `"size": "${options.quality}", "cuts": ["<anything you left out to keep it readable>"]}`,
    'Then draw it.',
    '',
    `When it is delivered, reply with the one line: wrote ${out}`,
  ].join('\n')
}
