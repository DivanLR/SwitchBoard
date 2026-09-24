export const DESIGN_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'pdf', 'md', 'txt', 'html'] as const

export const MAX_DESIGNS = 20

export const MAX_DESIGN_BYTES = 20 * 1024 * 1024

export function designName(path: string): string {
  return path.replace(/^.*[\\/]/, '')
}

export function isDesignFile(path: string): boolean {
  const ext = /\.([^.\\/]+)$/.exec(path)?.[1]?.toLowerCase() ?? ''
  return (DESIGN_EXTENSIONS as readonly string[]).includes(ext)
}

export function designFileNames(paths: readonly string[]): string[] {
  const taken = new Set<string>()
  return paths.map((path) => {
    const name = designName(path).replace(/[^\w.-]+/g, '-')
    const dot = name.lastIndexOf('.')
    const stem = dot > 0 ? name.slice(0, dot) : name
    const ext = dot > 0 ? name.slice(dot) : ''
    let next = name
    for (let n = 2; taken.has(next.toLowerCase()); n += 1) next = `${stem}-${n}${ext}`
    taken.add(next.toLowerCase())
    return next
  })
}
