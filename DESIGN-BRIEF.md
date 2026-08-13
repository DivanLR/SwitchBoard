# Switchboard — design brief

**Everything a designer needs to refine this product's interface, in one file.**
Written to be handed to someone with no access to the repository. Every value in
here was read out of the running code, not remembered.

---

## 0. How to use this document

Read sections 1–3 to understand what the thing is and what it is for. Sections
4–8 are the design system as it currently stands, with real values. Section 9 is
what you cannot change and why. **Section 10 is the most important one** — it
lists directions that have already been tried and rejected, so you do not spend
your effort re-proposing them. Section 11 is the list of known problems nobody
has fixed yet, which is where the useful work is.

When you propose something, name the **token** it changes, not the screen. This
interface is built entirely from CSS custom properties; a change expressed as
"the cards should breathe more" costs an afternoon of guessing, and the same
change expressed as "`--pad-card` goes from `10px 13px` to `12px 16px`" is one
line.

---

## 1. What Switchboard is

A Windows desktop application (Electron 43 + Vue 3) that runs **many Claude Code
sessions at once, in one window**. Claude Code is a terminal coding agent;
normally you run one per terminal tab and babysit it. Switchboard hosts a dozen,
across a dozen projects, and gives you one place to see what they are all doing.

**The user is one developer.** Not a team, not an enterprise. One person with
between five and twenty repositories, running agents against several of them
simultaneously, who needs to know at a glance which ones are working, which have
stopped and are waiting for them, and which have gone wrong.

**The single job of the interface: make "what needs me right now" instantly
obvious, and make everything else stay quiet.** An agent that is working needs
no attention. An agent blocked on a permission needs it immediately. Most of the
design problems in this product are failures of that distinction — something
quiet drawn loudly, or something urgent drawn like furniture.

### The vocabulary

| Term | Meaning |
| --- | --- |
| **Project** | A folder on disk with a git repository in it. |
| **Session** | One running Claude Code agent, belonging to a project. A project can have several. |
| **Background session** | A session started *by a section* rather than by the user, to do a job. Nobody opens it; its output surfaces in the section that asked. |
| **Event** | One thing that happened in a session: a prompt, a reply, a tool call, an error. Sessions are append-only streams of these. |
| **Permission request** | The agent wants to do something and is blocked until the user says yes. These are the urgent things. |
| **Mode** | How much a session is allowed to do without asking. Six of them, from "ask about everything" to "never ask, and run in a Docker container". |

---

## 2. The window

Three columns, always. Nothing is a modal that could have been a panel.

```
┌────────────┬───────────────────────────────────────────┬──────────────┐
│            │  storefront  C:\work\storefront    [Plan] │  INBOX  3    │
│ switchboard│  branch +12 -4  session 00:04:11         │  HISTORY     │
│            ├───────────────────────────────────────────┤              │
│ [filter  ] │  SESSION SPECS TESTS DIFF CLEANUP DIAGRAMS│  ┌─────────┐ │
│            ├───────────────────────────────────────────┤  │ Edit the│ │
│ PROJECTS 6 │                                           │  │ cart... │ │
│ • storefront│           (the session stream:            │  │[Approve]│ │
│   fix/cart │            prompts, replies, tool calls,   │  └─────────┘ │
│ • api-server│           summaries, errors)              │  ┌─────────┐ │
│   feat/auth│                                           │  │ Run the │ │
│ • ml-pipeline│                                          │  │ tests...│ │
│ • infra    │                                           │  └─────────┘ │
│            ├───────────────────────────────────────────┤              │
│ ⚙ Settings │  ❯ [ Send a message to storefront…  ] Send│              │
├────────────┴───────────────────────────────────────────┴──────────────┤
│ ● RUN 2   ● WAIT 3   │  TODAY $4.12   82k tok            ⏎ send       │
└───────────────────────────────────────────────────────────────────────┘
```

- **Left rail, 276px.** Projects, each with a status mark, its git branch and a
  running timer. Sessions nest under their project. Settings pinned at the
  bottom. Collapsible.
- **Centre.** A header (project name, path, branch, diff counts, mode controls),
  a strip of six section tabs, the section itself, and the composer pinned to
  the bottom.
- **Right rail, 332px, resizable 280–680, collapsible.** The inbox: every
  permission request across every project, grouped by project. This is the
  "needs me" column and it is always visible on purpose.
- **Status bar.** One line under everything: how many sessions are running, how
  many are waiting, today's spend and token count.

---

## 3. The six sections

The centre pane switches between these. All six belong to the selected project.

| Section | What it is | Shape of the content |
| --- | --- | --- |
| **Session** | The conversation. The default. | A vertical stream of events, bottom-anchored like a terminal. Prompts, assistant text, tool-call rows, summary cards, error cards. A "Clean / Raw" toggle switches between a readable rendering and the literal terminal output. |
| **Specs** | GitHub Spec Kit. Write a spec, break it into tasks, implement them. | A spec list, then a selected spec with status chips, a task list with checkboxes, and command cards. Dense. |
| **Tests** | Verification. Pick your stack, choose what to verify, run it. | A stack picker, a grid of six "gates" (unit, coverage, e2e, lint, mutation, API) each with a figure, and drill-downs. Also holds the eval loop for small changes. |
| **Diff** | Uncommitted working-tree changes. | A file tree on the left, one file's diff on the right. Read-only. |
| **Cleanup** | A launcher for curated code-review and cleanup commands from installed plugins. | Groups of command rows, each showing whether the plugin that provides it is installed. |
| **Diagrams** | Describe a diagram, a background session draws it as standalone HTML. | A text box, a list of past diagrams, and the selected one rendered in a sandboxed iframe. |

There is also a **Database MCP** view (talk to a project's database server
directly, and run a schema scan), reached from a reserved row in the sidebar,
and a **Settings** modal with a left icon rail of six tabs.

---

## 4. Typography

**The whole interface is set in JetBrains Mono.** Not just code — every label,
every button, every project name, all of it. This is deliberate and is the
product's most distinctive property. It is a tool for running terminal agents
and it reads as one.

The shipped file is the **variable** face, weight axis 400–800, Latin subset
only (663 codepoints — this matters, see §6).

### The ramp

Six tokens, **three real sizes**. The collapse is the point: a grid with six
sizes is not a grid.

| Token | Value | Used for |
| --- | --- | --- |
| `--fs-micro` | 11px | Uppercase section labels, timestamps, counts |
| `--fs-meta` | 11px | Secondary detail, button labels |
| `--fs-ui` | 12.5px | Control labels, list items, most chrome |
| `--fs-body` | 12.5px | Body text — most of what you read |
| `--fs-title` | 14px | Card titles |
| `--fs-head` | 14px | The session header, project names |

`--track-label: 0.08em` is the one letter-spacing, for uppercase micro-labels.

### Weight

One token, two values:

| Token | Dark | Light |
| --- | --- | --- |
| `--w-em` | **500** | **400** |

Dark ink on a bright ground gains weight optically — the same glyph that needs
500 to hold up light-on-dark reads as bold dark-on-light. In a monospace face a
heavy stroke closes the counters and costs the face its character. In light
mode, emphasis is carried by the ink tier and the surface a thing sits on, not
by weight.

**Known tension:** 12.5px is a fractional size, which does not land on the pixel
grid, and the ramp's own comment claims the sizes are "twelve, fourteen,
sixteen". One of the two is wrong and nobody has decided which.

---

## 5. Colour

Two complete themes. They are **not** inversions of each other — see §8 for what
each one is *for*.

### Surfaces

| Token | Dark | Light |
| --- | --- | --- |
| `--bg` | `#17181B` | `#F4F6F9` |
| `--bg-panel` | `#131417` | `#EAEDF2` |
| `--bg-panel-2` | `#181A1D` | `#E6E9EF` |
| `--bg-card` | `#1D1F23` | `#FFFFFF` |
| `--bg-card-alt` | `#1B1D21` | `#F9FBFD` |
| `--bg-code` | `#141518` | `#EEF1F5` |
| `--bg-hover` | `rgba(244,244,242,.06)` | `rgba(15,19,26,.045)` |
| `--bg-active` | `#B9B6AE` at 12% | `#0F131A` at 9% |

Note the inversion of logic: in dark, a card is **lighter** than the ground; in
light, a card is **white** and floats above a cool grey canvas. In light mode a
wash *subtracts* light (a mark on a bright ground is ink, never a lightening).

### Ink

| Token | Dark | Light |
| --- | --- | --- |
| `--text-bright` | `#F4F4F2` | `#0F131A` |
| `--text` / `--text-strong` | `#E6E5E1` | `#1B2027` |
| `--text-title` | `#D8D7D2` | `#262B33` |
| `--text-name` | `#D2D1CC` | `#22272E` |
| `--text-body` | `#B7B6B0` | `#3A3F47` |
| `--text-mid` | `#9B9A94` | `#545961` |
| `--text-meta` | `#A3A29C` | `#5C6169` |
| `--text-faint` / `--text-tab` | `#A3A29C` / `#9B9A94` | `#61666E` |
| `--text-label` / `--text-ghost` / `--text-noise` | `#97968F` | `#656A72` |
| `--text-on-wash` | `#AEADA6` | `#4E535B` |

`--text-on-wash` is its own role rather than a ramp step: it is measured against
the *composite* of a hover wash over a card, not against the flat ground.

### Signal

| Token | Dark | Light | Means |
| --- | --- | --- | --- |
| `--green` | `#4DC97E` | `#136F45` | **The action.** The one thing to click. |
| `--green-hover` | `#6FD695` | `#0F5A38` | |
| `--green-ink` | `#17181B` | `#FFFFFF` | Text on a green fill |
| `--running` | `#4DC97E` | `#136F45` | **State:** a session is working |
| `--idle` | `#E09B42` | `#A6640B` | **State:** no session running |
| `--amber` | `#8CB8E4` | `#8F5600` | Attention owed |
| `--red` | `#E8705C` | `#A0141B` | Error |
| `--teal` | `#8FB0C4` | `#1D6E80` | Database / MCP |
| `--purple` | `#A99BD0` | `#6B4E9B` | Project identity |

`--green` and `--running` hold the same value but are separate tokens on
purpose: one is what an **action** is drawn in, the other is what a **state** is
drawn in. They agreed in dark all along and disagreed in light for exactly one
release, which is the argument for the pair existing.

**Note the oddity:** in dark, "amber" is `#8CB8E4`, which is *blue*. The name is
a lie inherited from an earlier palette. In light it is a genuine dark amber,
because no saturated warm hue clears 4.5:1 on a near-white ground in sRGB.

### Borders

Two distinct tiers, and the distinction is load-bearing:

- **Boundary tiers** — `--border-strong`, `--border-seg`, `--border-card`. These
  are a *control's own edge* (inputs, quiet buttons, chips, segmented controls,
  menus). Each clears **3:1** against the surface behind it. In light: measured
  4.73, 3.08, 3.11.
- **Separation tiers** — `--border`, `--border-code`, `--border-card-alt`,
  `--border-soft`, `--border-hist`. These rule one surface off another where the
  two already differ in tone, so the hairline is a second cue rather than the
  only one. Held deliberately soft (1.2–1.4:1). Forcing 3:1 onto every hairline
  is what turns a calm interface into a wireframe.

---

## 6. The icon set

**45 marks**, drawn as inline SVG on one 16-unit grid, 1.5 stroke, round caps
and joins, `currentColor` throughout, default 14px.

Names are semantic — what a mark *means*, never what it looks like:

```
Outcomes    check  cross  close  warning  spark  star
Movement    arrow-right  arrow-left  arrow-up  arrow-down
            chevron-right  chevron-left  chevron-down  chevron-up
            external  swap  download  refresh
Actions     play  stop  pencil  plus  minus  trash  search  send  settings
Objects     database  branch  folder  file  terminal  layers  scales  fork
            clock  panel  grid  moon  sun
State       dot  circle  diamond  square  square-check
```

`close` and `cross` are deliberately the **same mark** under two names: one X
for every negation, but a call site still reads as what it means.

### Why this exists — the single biggest defect that has been fixed

Every icon in this app used to be a Unicode character printed as text: `✓ → ✕ ▶
✎ ● ⚠ ✦ ⚙ ⛁ ⎇ 🗑` and fifty more. Measured against the font actually shipped,
**58 of the 61 glyphs in use were not in it.** They all fell back to Segoe UI
Symbol, and two (`🗑`, `🔊`) to Segoe UI Emoji, which renders in fixed colour and
ignores the colour it is given.

A fallback glyph does not share the surrounding text's stroke weight, does not
sit on its baseline, and ignores the variable weight axis the rest of the
interface is tuned on. Two marks from two Unicode blocks land in two different
faces side by side. That is why the chrome never looked like one product, and it
is worth knowing because **any proposal to go back to text glyphs is a
regression.**

Three glyphs are still text, correctly: `▊` (the streaming text cursor), `⎿`
(a tree-branch character inside raw terminal output), and `❯` (the terminal
prompt in raw output). These are part of the terminal fiction, not chrome.

---

## 7. Space, shape, depth, motion

### Space

A 4px-ish step, with half-steps where a control sits tighter than its box.

| Token | Value |
| --- | --- |
| `--sp-1` … `--sp-7` | 4, 6, 8, 10, 13, 16, 22px |
| `--pad-card` | `10px 13px` — the one padding for a list-item card |

This scale is **new**. Before it, every padding in the sheet was a literal chosen
at the call site, which is how one list-item card ended up drawn five different
ways across four files. Many components have not been repointed onto it yet.

### Shape

| Token | Dark | Light |
| --- | --- | --- |
| `--rc` (card) | **0px** | **6px** |
| `--rp` (pill) | **0px** | **4px** |

**Dark mode has square corners. This is intentional.** The dark theme's rule is
"on carbon a fold is a cut". Light mode rounds, because the reference it was
built against does. A proposal to round dark mode is a proposal to change the
product's identity — allowed, but say so explicitly.

### Depth

- `--elev` — the standard card lift: an inset top highlight plus a soft drop.
- `--gloss` — a barely-there top-light gradient laid over solid fills.
- `--green-glow` — a *coloured* shadow. **Only the composer's Send button uses
  it.** Elevation marks the one primary action in the window; every other solid
  button is flat. It used to sit under every solid button, which made an inbox
  with three items a rail of three glowing Approves.
- `--shadow-dlg`, `--shadow-dd`, `--shadow-menu` — modal, dropdown, menu.
- `--scrim` — behind a modal. `rgba(10,11,13,.66)` dark, `rgba(15,19,26,.44)` light.

### Motion

**One curve for everything:** `--ease: cubic-bezier(0.2, 0.7, 0.3, 1)`. It
leaves quickly and settles slowly, which is what mass looks like; the browser's
symmetric `ease` is what nothing in the physical world does.

Durations are short (0.12–0.15s). A `prefers-reduced-motion` block cuts every
animation to 0.01ms. **There is no ambient or decorative animation anywhere and
none is wanted.** The only pulsing element in the app is the inbox pending
badge, and that is a genuine alarm.

---

## 8. What each theme is *for*

This is the part most likely to be got wrong.

### Dark — "the carbon sheet"

The home ground. A tool for running terminal agents, and it reads as one:
monospace grid, square corners, a foil-green accent that looks like something
pressed into a surface rather than painted on it. Ink is warm-neutral
(`#E6E5E1`) on near-black, not pure white on pure black.

**Keep the terminal character.** It is not a dark-mode-as-a-courtesy; it is the
product's identity, and it is the mode the owner works in.

### Light — "cornflower"

Rebuilt against a named reference: *white cards floating on a cool light-grey
canvas, a single restrained accent, soft low-alpha shadows, nothing shouts.*

The ground is cool grey-blue, not warm paper. Ink and ground agree in
temperature rather than opposing it — deliberately the opposite of the dark
sheet's rule, because the warm-on-cool opposition is what made the old light
theme read as a *printed material*, and a material is what was asked to go away.

The brief for light mode, in the owner's words: **modern, clean, professional,
follows the industry.** Think Linear, Vercel, Height. Restrained, generous,
clear hierarchy, one accent.

---

## 9. Hard constraints

Things that cannot change, and why.

1. **No colour, font, or shadow literals in components.** Every such value is a
   token in one stylesheet. A proposal must be expressible as token changes.
2. **Contrast floors are measured, not judged by eye.** 4.5:1 for anything
   carrying text; 3:1 for a border that *is* a control's boundary. A border that
   only separates two surfaces which already differ in tone is held to no floor.
3. **One typeface.** JetBrains Mono, Latin subset. Adding a second face is a
   real proposal but a large one — it would need embedding, and it would change
   what the product *is*.
4. **Windows desktop, one window.** No responsive breakpoints below ~1000px
   matter. The window is typically 1440–1920 wide. There is no mobile.
5. **Every interactive element carries a test id.** Cosmetic changes must not
   remove them.
6. **The three columns are fixed furniture.** Sidebar, centre, inbox. The inbox
   is always visible (collapsible, but visible by default) because it is the
   "needs me" column.
7. **No decorative motion, no gradients as ornament, no glassmorphism.** The
   product is an instrument.

---

## 10. Already tried and rejected — do not re-propose

This is the section that saves you a wasted round.

| Tried | What happened |
| --- | --- |
| **A cornflower-blue accent** (taken wholesale from the light reference) | Shipped for one release. Rejected — the accent went back to green. What survived from the reference is its *neutrals*: the cool canvas, white cards, soft hairlines, 6px corners. |
| **A bigger type ramp** | Sizes were lifted across the board and the result was rejected in three words: *"big and ugly"*. The ramp collapsed back to three sizes. |
| **Bold weight for emphasis** | 46 declarations at weight 600/700. Rejected — bold ruins the character of a monospace face. Now one `--w-em` token, 500 dark / 400 light. |
| **A coloured glow on every solid button** | Made an inbox rail of three glowing Approves and a fourth under every section's Generate. Now only the composer's Send lifts. |
| **The action colour on the view toggle** | Made a *view preference* the loudest control in the header, louder than End and louder than the pending count. Selection is now drawn in the selection wash. |
| **A global `filter: brightness/saturate`** on the document | Removed. A sheet's tone is authored per token, not boosted afterwards. It also created a containing block that broke fixed-position overlays. |
| **A "Design" section inside the app** for capturing design notes | Built, then removed at the owner's request. Design feedback happens in the design lab (a local page), not inside the product. |
| **Warm paper for light mode** | The previous light theme. Rejected as reading like a printed material. |

---

## 11. Known open problems

Found by a six-agent audit of every view, component and the token sheet — 74
findings. These are the ones still unfixed. **This is where the useful work is.**

### The token layer contradicts itself

- **Duplicate tokens.** `--detail` is byte-identical to `--text-mid` in both
  themes. `--text` is byte-identical to `--text-strong`. `--blue` is
  byte-identical to `--amber`. Three names that are not roles.
- **The ink alias maps differ between themes.** Dark collapses `--text-mid` and
  `--text-tab` to one value; light keeps them apart. Dark collapses
  `--text-meta` and `--text-faint`; light does not. So a component swapping one
  token for another is a no-op in dark and a visible change in light — a
  cross-theme behaviour difference baked into the token layer.
- **`--surface-*` duplicates `--bg-*` under different names**, and *which*
  `--bg-*` each one mirrors **flips between themes**. `--surface-raised` equals
  `--bg-panel` in light but `--bg-card` in dark.
- **The type ramp's comment contradicts its values** (claims 12/14/16, the
  tokens read 11/12.5/14), and 12.5px violates the ramp's own stated
  whole-pixel principle.
- **The dialog's cut-corner is a hardcoded 10px chamfer**, the one geometry value
  in the sheet not driven by a token.
- In dark, `--border-seg` and `--border-card` collapse to one value, while light
  measures them separately. The rigour exists in one theme only.

### Consistency across views

- **Five paddings for one "labelled card"** across four files (11px 12px,
  10px 13px, 12px 14px, 9px 12px). `--pad-card` now exists; most call sites have
  not moved onto it.
- **Two tab-bar implementations** for the same job — different padding, a
  different "selected" ink token, and two different techniques for the same
  green underline (`border-bottom` in one, `inset box-shadow` in the other).
- **Empty states are inconsistent.** One section has a full treatment (centred,
  hero mark, title, subtitle, call to action); others are a single line of grey
  text. Nobody has picked which is right.
- **Two count-badge shapes** for the same job: one an amber outline chip with no
  radius, the other a solid green pill with one.

### Hierarchy

- **The bulk "Approve all" high-risk confirm is a bare text link**, while the
  single-item high-risk confirm two hundred lines away is a bordered, filled
  button with a hover lift. The *more* consequential action is drawn lighter.
- **The Tests headline score uses the same size as each of the six gate figures
  it summarises** — only weight separates them, so the summary does not outrank
  what it summarises.
- **The Settings "Done" button uses the primary treatment**, though every row in
  that dialog autosaves and Done only closes it.

### Light mode specifically

- **The Settings left rail is filled with `--bg-code`** — the sunken code-block
  surface, meant for printed commands. In light mode it makes the settings
  sidebar read as a code block rather than as calm chrome.

---

## 12. What I want from you

In priority order:

1. **A light mode that looks like it was designed in the last two years.** Clean,
   modern, professional, the kind of thing you would see from Linear or Vercel.
   The neutrals and the white cards are already close; the hierarchy is not.
2. **A dark mode that stays a terminal.** Do not modernise the identity out of
   it. If it improves, it should improve as an instrument.
3. **Resolve the token contradictions in §11** with a coherent scheme rather than
   patch by patch. Especially the ink ramp: how many tiers does this interface
   actually need, and what is each one *for*?
4. **One empty-state pattern, one card, one tab bar, one badge.** Pick them.
5. **Tell me what to delete.** The sheet has 89 tokens in dark and 70 in light.
   That is probably too many.

### How to give feedback that lands

Name the token. `--text-meta should be #6B7078 in light, one step lighter than
--text-mid, because right now they are indistinguishable` is a change I can make
in ten seconds and see immediately. `the secondary text is muddy` is a
conversation.

If you want to propose something structural — a second typeface, a different
accent, a new spacing rhythm — say so plainly and say what it costs. Those are
allowed; they just are not free.

---

## Appendix: the design lab

There is a local page for looking at all of this: `npm run design` serves it at
`http://localhost:4321`. It links the **real** stylesheet and the real fonts, so
every specimen on it is drawn by the app's own sheet — change a token, refresh,
see it. It shows the type ramp, the weight, four groups of colour swatches, all
45 icons, the buttons, the pills, a list-item card, the section tabs, the sidebar
rows, the composer and an empty state, in both themes.
