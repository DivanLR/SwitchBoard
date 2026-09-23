import type { FlowStartSource } from '@shared/ipc-types'

export interface AdoFeatureLink {
  organisation: string | null
  project: string | null
  id: string
  url: string | null
}

type AdoSource = Extract<FlowStartSource, { kind: 'ado' }>

const ID = /^[1-9]\d{0,9}$/
const ORGANISATION = /^[A-Za-z0-9][A-Za-z0-9-]{0,49}$/
const PROJECT_REFUSED = /[\\/:*?"<>|;#${},+=[\]`\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u
const UNQUOTED = /[\p{Cf}"`“”]/gu
const VISUALSTUDIO = '.visualstudio.com'

export function isAdoId(value: string): boolean {
  return ID.test(value)
}

export function adoProjectName(value: string | null | undefined): string | null {
  const name = value?.trim() ?? ''
  if (name.length === 0 || name.length > 64 || PROJECT_REFUSED.test(name)) return null
  if (name.startsWith('_') || name.startsWith('.') || name.endsWith('.')) return null
  return name
}

export function adoTitle(value: unknown, max = 200): string | null {
  if (typeof value !== 'string') return null
  const title = value.replace(UNQUOTED, '').replace(/[\p{Cc}\s]+/gu, ' ').trim().slice(0, max).trim()
  return title || null
}

export function adoFeatureUrl(organisation: string, project: string, id: string): string {
  return `https://dev.azure.com/${organisation}/${encodeURIComponent(project)}/_workitems/edit/${id}`
}

function workItemId(path: readonly string[], query: URLSearchParams): string | null {
  const [hub, ...rest] = path.map((part) => part.toLowerCase())
  if (hub === '_workitems') {
    if (rest.length === 2 && rest[0] === 'edit') return rest[1]
    return rest.length === 0 ? query.get('id') : null
  }
  if ((hub === '_boards' || hub === '_backlogs') && rest.length > 0) return query.get('workitem')
  return null
}

export function parseAdoFeatureLink(text: string): AdoFeatureLink | null {
  const raw = text.trim()
  const bare = raw.replace(/^#/, '')
  if (ID.test(bare)) return { organisation: null, project: null, id: bare, url: null }
  if (!URL.canParse(raw)) return null
  const url = new URL(raw)
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') return null
  let parts: string[]
  try {
    parts = url.pathname.split('/').filter((part) => part !== '').map((part) => decodeURIComponent(part))
  } catch {
    return null
  }
  const host = url.hostname
  let organisation: string | undefined
  if (host === 'dev.azure.com') organisation = parts.shift()
  else if (host.endsWith(VISUALSTUDIO)) {
    organisation = host.slice(0, -VISUALSTUDIO.length)
    if (parts[0]?.toLowerCase() === 'defaultcollection') parts.shift()
  }
  if (!organisation || !ORGANISATION.test(organisation)) return null
  const hub = parts.findIndex((part) => part.startsWith('_'))
  if (hub !== 1 && hub !== 2) return null
  const [rawProject, team] = parts
  const project = adoProjectName(rawProject)
  if (!project || project !== rawProject || (hub === 2 && adoProjectName(team) !== team)) return null
  const id = workItemId(parts.slice(hub), url.searchParams)
  if (!id || !ID.test(id)) return null
  return { organisation, project, id, url: adoFeatureUrl(organisation, project, id) }
}

export function checkedAdoSource(source: AdoSource): AdoSource | null {
  const rawId: unknown = source.featureId
  const id = typeof rawId === 'string' ? rawId.trim() : ''
  if (!ID.test(id)) return null
  const given: unknown = source.url
  if (given !== null && given !== undefined && typeof given !== 'string') return null
  let url: string | null = null
  if (typeof given === 'string' && given.trim() !== '') {
    const link = parseAdoFeatureLink(given)
    if (!link?.url || link.id !== id) return null
    url = link.url
  }
  return { kind: 'ado', featureId: id, featureTitle: adoTitle(source.featureTitle) ?? `Feature ${id}`, url }
}
