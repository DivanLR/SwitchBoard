// Stable per-project accent colour, keyed by project id, so a project reads the
// same colour in the sidebar row stripe and the session header dot. Shared by
// Sidebar.vue and SessionView.vue (was duplicated verbatim in both).
//
// Theme tokens, not literal hexes: the design defines these six as palette
// variables that are redefined in light mode, so a hardcoded hex reads as the
// dark accent on a light background.
const PROJECT_ACCENTS = [
  'var(--blue)',
  'var(--amber)',
  'var(--purple)',
  'var(--green)',
  'var(--red)',
  'var(--teal)',
]

export function accentFor(id: string): string {
  let hash = 0
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return PROJECT_ACCENTS[hash % PROJECT_ACCENTS.length]
}

/** Group swatch colours, in the design's own order, handed out round-robin as
 *  groups are created. Same six accents as the project stripes. */
export const GROUP_COLORS = [
  'var(--green)',
  'var(--purple)',
  'var(--blue)',
  'var(--amber)',
  'var(--teal)',
  'var(--red)',
]
