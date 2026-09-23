import { describe, expect, it } from 'vitest'
import { resolve, sep } from 'node:path'
import { devRendererUrl, resolveBundlePath } from '@main/bundle-path'

const ROOT = resolve('/app/out/renderer')

describe('devRendererUrl', () => {
  const env = { ELECTRON_RENDERER_URL: 'http://localhost:5173' }

  it('ignores the dev server variable in a packaged build, so the bundle and its CSP always load', () => {
    expect(devRendererUrl(true, env)).toBeUndefined()
  })

  it('honours it in development only', () => {
    expect(devRendererUrl(false, env)).toBe('http://localhost:5173')
    expect(devRendererUrl(false, {})).toBeUndefined()
  })
})

describe('resolveBundlePath', () => {
  it('serves files inside the bundle', () => {
    expect(resolveBundlePath(ROOT, '/index.html')).toBe(resolve(ROOT, 'index.html'))
    expect(resolveBundlePath(ROOT, '/assets/index-a7q0Jle5.js')).toBe(
      resolve(ROOT, 'assets/index-a7q0Jle5.js'),
    )
    expect(resolveBundlePath(ROOT, '/assets/fonts/jetbrains-mono-latin.woff2')).toBe(
      resolve(ROOT, 'assets/fonts/jetbrains-mono-latin.woff2'),
    )
  })

  it('serves the bundle root itself', () => {
    expect(resolveBundlePath(ROOT, '/')).toBe(ROOT)
  })

  it('refuses to climb out of the bundle', () => {
    expect(resolveBundlePath(ROOT, '/../main/index.js')).toBeNull()
    expect(resolveBundlePath(ROOT, '/../../../Windows/System32/config/SAM')).toBeNull()
    expect(resolveBundlePath(ROOT, '/assets/../../secret.txt')).toBeNull()
  })

  it('refuses an encoded climb, because the path is resolved before it is judged', () => {
    expect(resolveBundlePath(ROOT, '/%2e%2e/main/index.js')).toBeNull()
    expect(resolveBundlePath(ROOT, '/assets/%2E%2E%2F%2E%2E%2Fsecret.txt')).toBeNull()
  })

  it('refuses a sibling directory that merely shares the prefix', () => {
    expect(resolveBundlePath(ROOT, '/../renderer-backup/index.html')).toBeNull()
  })

  it('refuses a malformed escape and an embedded NUL', () => {
    expect(resolveBundlePath(ROOT, '/%E0%A4%A')).toBeNull()
    expect(resolveBundlePath(ROOT, '/index.html%00.png')).toBeNull()
  })

  it('keeps every served path under the bundle directory', () => {
    for (const pathname of ['/index.html', '/a/b/c.js', '/./index.html', '/assets/x/../y.css']) {
      const served = resolveBundlePath(ROOT, pathname)
      expect(served).not.toBeNull()
      expect(served === ROOT || served!.startsWith(ROOT + sep)).toBe(true)
    }
  })
})
