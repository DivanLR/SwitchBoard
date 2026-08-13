// The design lab: a local page for looking at Switchboard's design and saying
// what is wrong with it, without running the app.
//
// It serves the REAL stylesheet and the REAL fonts straight out of
// src/renderer, so what you see here is what the app draws. Edit a token, hit
// refresh, and the change is on screen — no build, no Electron, no session.
//
// Notes you write are POSTed back and appended to design-lab/NOTES.md, which is
// a plain file in the repo. That is the whole handover mechanism: you write,
// Claude reads the file, changes the tokens, you refresh.
//
// No dependencies and no framework on purpose. This is a tool for looking at
// something, and it should never be the thing that needs debugging.
import { createServer } from 'node:http'
import { readFile, appendFile, readFile as read } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// resolve() rather than the raw URL path: fileURLToPath leaves a trailing
// separator on a directory, and safeJoin compares against `base + sep`, so the
// guard rejected every file in this folder while happily serving src/renderer.
const HERE = resolve(fileURLToPath(new URL('.', import.meta.url)))
const ROOT = resolve(HERE, '..')
const RENDERER = join(ROOT, 'src', 'renderer')
const NOTES = join(HERE, 'NOTES.md')
const PORT = Number(process.env.PORT ?? 4321)

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.md': 'text/markdown; charset=utf-8',
}

/** Refuses anything that resolves outside the folder it is meant to serve. */
function safeJoin(base, urlPath) {
  const target = resolve(join(base, normalize(decodeURIComponent(urlPath))))
  return target === base || target.startsWith(base + (process.platform === 'win32' ? '\\' : '/'))
    ? target
    : null
}

async function serveFile(res, file) {
  if (!file || !existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not here')
    return
  }
  const body = await readFile(file)
  res.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    // The point of the lab is that a refresh shows the edit you just made.
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((done, fail) => {
    let data = ''
    req.on('data', (c) => {
      data += c
      if (data.length > 64_000) fail(new Error('too long'))
    })
    req.on('end', () => done(data))
    req.on('error', fail)
  })
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)

  if (req.method === 'POST' && url.pathname === '/note') {
    try {
      const { section, text, theme } = JSON.parse(await readBody(req))
      const clean = String(text ?? '').trim()
      if (!clean) {
        res.writeHead(400).end('empty')
        return
      }
      const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16)
      const where = String(section ?? 'general')
      await appendFile(
        NOTES,
        `\n- [ ] **${where}** _(${theme === 'light' ? 'light' : 'dark'}, ${stamp})_\n      ${clean.replace(/\n/g, '\n      ')}\n`,
        'utf8',
      )
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
    } catch {
      res.writeHead(400).end('bad note')
    }
    return
  }

  if (url.pathname === '/notes') {
    const body = existsSync(NOTES) ? await read(NOTES, 'utf8') : ''
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ markdown: body }))
    return
  }

  // The app's own stylesheet and fonts, live from source.
  if (url.pathname.startsWith('/app/')) {
    await serveFile(res, safeJoin(RENDERER, url.pathname.slice('/app/'.length)))
    return
  }

  await serveFile(res, safeJoin(HERE, url.pathname === '/' ? 'index.html' : url.pathname))
})

server.listen(PORT, () => {
  console.log(`\n  Design lab  →  http://localhost:${PORT}`)
  console.log(`  Notes land in design-lab/NOTES.md\n`)
})
