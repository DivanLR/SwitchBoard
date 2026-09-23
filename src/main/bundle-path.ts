import { resolve, sep } from 'node:path'

export function devRendererUrl(isPackaged: boolean, env: Record<string, string | undefined>): string | undefined {
  return isPackaged ? undefined : env.ELECTRON_RENDERER_URL || undefined
}

export function resolveBundlePath(root: string, pathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  const target = resolve(root, `.${decoded}`)
  if (target !== root && !target.startsWith(root + sep)) return null
  return target
}
