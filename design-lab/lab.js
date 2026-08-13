// Renders the lab's panels, and posts notes back to the server.
//
// Every panel is built from the APP's own classes. Nothing here invents a
// style: if a specimen looks wrong on this page, it looks wrong in the app, and
// the fix belongs in src/renderer/styles.css rather than anywhere in here.

// The icon set, read from the component so the lab cannot drift from the app.
const MARKS = await fetch('/app/components/Icon.vue')
  .then((r) => r.text())
  .then((src) => {
    const body = src.slice(src.indexOf('const MARKS'), src.indexOf('const mark = computed'))
    const re = /'?([\w-]+)'?:\s*\{\s*\n?\s*d:\s*'([^']+)'(,\s*solid:\s*true)?/g
    const out = []
    let m
    while ((m = re.exec(body))) out.push({ name: m[1], d: m[2], solid: !!m[3] })
    return out
  })
  .catch(() => [])

const icon = (name, size = 14) => {
  const k = MARKS.find((x) => x.name === name)
  if (!k) return ''
  return `<svg viewBox="0 0 16 16" width="${size}" height="${size}" fill="${
    k.solid ? 'currentColor' : 'none'
  }" stroke="${
    k.solid ? 'none' : 'currentColor'
  }" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${k.d}"/></svg>`
}

// Which tokens to show as swatches, grouped the way the sheet groups them.
const SWATCHES = {
  Surfaces: ['--bg', '--bg-panel', '--bg-panel-2', '--bg-card', '--bg-card-alt', '--bg-code', '--bg-hover', '--bg-active'],
  Ink: ['--text-bright', '--text', '--text-body', '--text-mid', '--text-faint', '--text-label'],
  Signal: ['--green', '--green-hover', '--running', '--idle', '--amber', '--red', '--teal', '--purple'],
  Edges: ['--border-strong', '--border-seg', '--border-card', '--border', '--border-soft'],
}

const TYPE = [
  ['--fs-head', 'Session header — a project name'],
  ['--fs-title', 'A card title'],
  ['--fs-body', 'Body text, which is most of what you read'],
  ['--fs-ui', 'Control labels and buttons'],
  ['--fs-meta', 'Timestamps, counts, secondary detail'],
  ['--fs-micro', 'UPPERCASE SECTION LABELS'],
]

const SECTIONS = [
  {
    id: 'type',
    name: 'Type ramp',
    note: 'Six tokens, three real sizes. Everything in the app is JetBrains Mono.',
    html: () =>
      TYPE.map(
        ([tok, sample]) =>
          `<div class="lab-type-row"><span class="lab-type-tok mono">${tok}</span><span class="mono" style="font-size: var(${tok})">${sample}</span></div>`,
      ).join(''),
  },
  {
    id: 'weight',
    name: 'Emphasis weight',
    note: '--w-em is 500 in dark and 400 in light: dark ink on a bright ground gains weight optically.',
    html: () =>
      `<div class="lab-stack">
         <span class="mono" style="font-size: var(--fs-title)">Regular 400 — the sidebar, body copy, most labels</span>
         <span class="mono" style="font-size: var(--fs-title); font-weight: var(--w-em)">Emphasis var(--w-em) — names, titles, the selected thing</span>
       </div>`,
  },
  ...Object.entries(SWATCHES).map(([group, tokens]) => ({
    id: `colour-${group.toLowerCase()}`,
    name: `Colour · ${group}`,
    note: '',
    html: () =>
      `<div class="lab-swatches">${tokens
        .map(
          (t) =>
            `<div class="lab-swatch"><span class="lab-chip" style="background: var(${t})"></span><span class="lab-swatch-name mono">${t}</span></div>`,
        )
        .join('')}</div>`,
  })),
  {
    id: 'buttons',
    name: 'Buttons',
    note: 'Elevation belongs to the one primary action; a solid fill is enough for the rest.',
    html: () =>
      `<div class="lab-row">
         <button class="btn-solid">Approve</button>
         <button class="btn-outline">Deny</button>
         <button class="btn-quiet">Skip</button>
         <button class="btn-armed">Confirm high-risk</button>
         <button class="btn-solid" disabled>Disabled</button>
       </div>`,
  },
  {
    id: 'pills',
    name: 'Pills and chips',
    note: 'State, not action.',
    html: () =>
      `<div class="lab-row">
         <span class="pill working">Working</span>
         <span class="pill">Idle</span>
         <span class="pill ended">Ended</span>
         <span class="chip mono">auto</span>
         <span class="chip-risk low">Low</span>
         <span class="chip-risk medium">Medium</span>
         <span class="chip-risk high">High</span>
       </div>`,
  },
  {
    id: 'icons',
    name: `Icon set · ${MARKS.length} marks`,
    note: 'One 16-unit grid, one 1.5 stroke, currentColor. Replaced 61 text glyphs, 58 of which the shipped font never contained.',
    html: () =>
      `<div class="lab-icons">${MARKS.map(
        (k) => `<div class="lab-icon">${icon(k.name, 20)}<span>${k.name}</span></div>`,
      ).join('')}</div>`,
  },
  {
    id: 'card',
    name: 'A list-item card',
    note: 'One padding everywhere: var(--pad-card).',
    html: () =>
      `<div style="max-width: 420px; padding: var(--pad-card); background: var(--bg-hover); box-shadow: var(--elev); border: 1px solid var(--border-card); border-radius: var(--rc)">
         <div style="display:flex; align-items:baseline; gap:10px">
           <span style="font-size: var(--fs-ui); color: var(--text-body); font-weight: var(--w-em)">Edit the cart state hook</span>
           <span class="chip-risk low" style="margin-left:auto">Low</span>
         </div>
         <div class="mono" style="margin-top:6px; font-size: var(--fs-micro); color: var(--text-faint)">0s ago</div>
         <div class="mono" style="margin-top:8px; padding:7px 9px; font-size: var(--fs-meta); color: var(--text-body); background: var(--bg-code); border:1px solid var(--border-code); border-radius: var(--rc)">src/hooks/useCart.ts (+41 -18)</div>
         <div class="lab-row" style="margin-top:10px">
           <button class="btn-solid">Approve</button>
           <button class="btn-outline">Deny</button>
         </div>
       </div>`,
  },
  {
    id: 'tabs',
    name: 'Section tabs',
    note: 'The selected tab, and the view toggle beside it.',
    html: () =>
      `<div class="lab-stack">
         <div class="lab-row" style="gap:0">
           ${['Session', 'Specs', 'Tests', 'Diff', 'Cleanup', 'Diagrams']
             .map(
               (t, i) =>
                 `<button class="mt${i === 0 ? ' sel' : ''}" style="background:transparent;border:none;padding:9px 13px;font-size:var(--fs-meta);letter-spacing:.08em;text-transform:uppercase;color:var(${
                   i === 0 ? '--text-bright' : '--text-tab'
                 });${i === 0 ? 'box-shadow: inset 0 -2px 0 var(--green);' : ''}cursor:pointer">${t}</button>`,
             )
             .join('')}
         </div>
         <div class="segments mono" style="display:inline-flex;align-self:flex-start;border:1px solid var(--border-seg);border-radius:var(--rp);overflow:hidden;font-size:var(--fs-ui)">
           <button class="seg on" style="padding:4px 12px;line-height:15px;font-weight:var(--w-em);background:var(--bg-active);color:var(--text-strong);border:none;cursor:default">Clean</button>
           <button class="seg" style="padding:4px 12px;line-height:15px;background:transparent;color:var(--text-tab);border:none;cursor:pointer">Raw</button>
         </div>
       </div>`,
  },
  {
    id: 'sidebar',
    name: 'Sidebar rows',
    note: 'The project rail: name, branch, status mark, timer.',
    html: () =>
      `<div style="max-width: 300px; background: var(--bg-panel); border:1px solid var(--border); border-radius: var(--rc); padding: 6px">
         ${[
           ['storefront', 'fix/cart-race', '--amber', true],
           ['api-server', 'feat/auth-refresh', '--amber', false],
           ['ml-pipeline', 'main', '--running', false],
           ['infra', 'main', '--red', false],
         ]
           .map(
             ([name, branch, colour, sel]) =>
               `<div style="display:flex;align-items:center;gap:9px;padding:7px 9px;border-radius:var(--rc);${
                 sel ? 'background: var(--bg-active);' : ''
               }">
                  <span style="color: var(${colour}); display:flex">${icon('dot', 9)}</span>
                  <div style="flex:1;min-width:0">
                    <div class="mono" style="font-size:var(--fs-ui);color:var(--text-name);font-weight:var(--w-em)">${name}</div>
                    <div class="mono" style="display:flex;align-items:center;gap:4px;font-size:var(--fs-micro);color:var(--text-faint);margin-top:2px">${icon('branch', 10)}${branch}</div>
                  </div>
                  <span class="mono" style="font-size:var(--fs-micro);color:var(--text-faint)">00:00:0${sel ? 2 : 1}</span>
                </div>`,
           )
           .join('')}
       </div>`,
  },
  {
    id: 'composer',
    name: 'Composer',
    note: 'The one primary action in the app, and the only thing that lifts.',
    html: () =>
      `<div style="max-width:720px;padding:11px 18px;background:var(--bg-panel);border-top:1px solid var(--border);border-radius:var(--rc)">
         <div style="display:flex;align-items:flex-end;gap:10px">
           <span style="color:var(--green);display:flex">${icon('chevron-right', 13)}</span>
           <div style="flex:1;padding:8px 11px;background:var(--bg-hover);border:1px solid var(--green);border-radius:var(--rc)">
             <span class="mono" style="font-size:var(--fs-body);color:var(--text-ghost)">Send a message to storefront…</span>
           </div>
           <span class="mono" style="font-size:var(--fs-meta);color:var(--text-faint)">to storefront</span>
           <button class="btn-outline">${icon('plus', 11)} Queue</button>
           <button class="send-btn" style="display:flex;align-items:center;gap:6px">Send ${icon('send', 11)}</button>
         </div>
       </div>`,
  },
  {
    id: 'empty',
    name: 'Empty state',
    note: 'Every section has one; they should all look like the same app.',
    html: () =>
      `<div style="max-width:520px;padding:var(--sp-7) var(--sp-5);text-align:center;color:var(--text-faint);border:1px dashed var(--border-soft);border-radius:var(--rc)">
         <span style="display:inline-flex;color:var(--text-faint)">${icon('pencil', 18)}</span>
         <div style="margin-top:8px;font-size:var(--fs-ui);color:var(--text-body)">Nothing here yet</div>
         <div style="margin-top:4px;font-size:var(--fs-meta)">What the section will hold, and how it gets there.</div>
       </div>`,
  },
]

// --- render

const host = document.getElementById('sections')
host.innerHTML = SECTIONS.map(
  (s) => `
  <section class="lab-panel" data-section="${s.name}">
    <div class="lab-panel-head">
      <span class="lab-panel-name">${s.name}</span>
      ${s.note ? `<span class="lab-panel-note">${s.note}</span>` : ''}
      <button class="lab-add mono" type="button" data-note="${s.name}">note this</button>
    </div>
    ${s.html()}
  </section>`,
).join('')

// --- notes

const dialog = document.getElementById('noteDialog')
const whereEl = document.getElementById('noteWhere')
const textEl = document.getElementById('noteText')
let pending = 'general'

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-note]')
  if (!btn) return
  pending = btn.dataset.note
  whereEl.textContent = pending
  textEl.value = ''
  dialog.showModal()
  textEl.focus()
})

dialog.addEventListener('close', async () => {
  if (dialog.returnValue !== 'save') return
  const text = textEl.value.trim()
  if (!text) return
  await fetch('/note', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      section: pending,
      text,
      theme: document.documentElement.classList.contains('sb-light') ? 'light' : 'dark',
    }),
  })
  await refreshNotes()
})

const notesEl = document.getElementById('notes')
const notesBody = document.getElementById('notesbody')
const count = document.getElementById('ncount')

async function refreshNotes() {
  const { markdown } = await fetch('/notes').then((r) => r.json())
  notesBody.textContent = markdown.trim() || 'No notes yet.'
  count.textContent = String((markdown.match(/^- \[ \]/gm) ?? []).length)
}

document.getElementById('shownotes').addEventListener('click', () => {
  notesEl.hidden = false
  void refreshNotes()
})
document.getElementById('closenotes').addEventListener('click', () => {
  notesEl.hidden = true
})

// --- theme

const themeBtn = document.getElementById('theme')
const setTheme = (light) => {
  document.documentElement.classList.toggle('sb-light', light)
  themeBtn.textContent = light ? 'Dark' : 'Light'
  localStorage.setItem('lab-theme', light ? 'light' : 'dark')
}
setTheme(localStorage.getItem('lab-theme') !== 'dark')
themeBtn.addEventListener('click', () =>
  setTheme(!document.documentElement.classList.contains('sb-light')),
)

void refreshNotes()
