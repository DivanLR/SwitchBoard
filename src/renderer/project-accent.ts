// Stable per-project accent colour, keyed by project id, so a project reads the
// same colour in the sidebar row stripe and the session header dot. Shared by
// Sidebar.vue and SessionView.vue (was duplicated verbatim in both).
const PROJECT_ACCENTS = ['#3a6291', '#9a6f2a', '#6f4d8f', '#34d399', '#8f3b2c', '#2dd4bf']

export function accentFor(id: string): string {
  let hash = 0
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return PROJECT_ACCENTS[hash % PROJECT_ACCENTS.length]
}
