---
name: Switchboard
description: Nine concurrent Claude Code sessions, engraved as one score rather than listed as rows.
colors:
  plate: "#2b3037"
  bone-ink: "#e8e4dc"
  text-body: "#bcb8b0"
  text-meta: "#a8a39a"
  text-tab: "#a09b92"
  text-ghost: "#9c968d"
  plate-vignette: "rgba(0,0,0,0.22)"
  lip-white: "rgba(255,255,255,0.06)"
  border: "rgba(232,228,220,0.1)"
  border-strong: "rgba(232,228,220,0.2)"
  bg-panel: "rgba(30,34,39,0.94)"
  bg-card: "rgba(38,43,49,0.7)"
  bg-code: "#1e2227"
  proof-cyan: "#57b9cf"
  proof-cyan-hover: "#74cbde"
  ochre: "#e0a760"
  oxblood: "#f0776a"
  viol-blue-violet: "#8f9fd8"
  brace-violet: "#bb8fd0"
typography:
  headline:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "15.5px"
    fontWeight: 600
    lineHeight: 1.3
  title:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "13.5px"
    fontWeight: 700
    letterSpacing: "0.02em"
  body:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.6
  ui:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "12px"
    fontWeight: 400
  label:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "11px"
    fontWeight: 400
    letterSpacing: "0.08em"
  meta:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "10.5px"
    fontWeight: 400
  caption:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "10px"
    fontWeight: 400
  mono:
    fontFamily: "'JetBrains Mono', ui-monospace, 'Cascadia Mono', monospace"
    fontSize: "11.5px"
    fontWeight: 400
  score:
    fontFamily: "Georgia, 'Iowan Old Style', 'Times New Roman', serif"
    fontWeight: 700
    fontStyle: "italic"
rounded:
  content: "3px"
  row: "8px"
  glyph: "6px"
  micro: "2px"
  pill: "99px"
spacing:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "14px"
  2xl: "18px"
  3xl: "22px"
components:
  button-primary:
    backgroundColor: "{colors.proof-cyan}"
    textColor: "#16191d"
    typography: "{typography.mono}"
    rounded: "{rounded.content}"
    padding: "6px 14px"
  button-primary-hover:
    backgroundColor: "{colors.proof-cyan-hover}"
  button-armed:
    backgroundColor: "{colors.ochre}"
    textColor: "#16191d"
    typography: "{typography.mono}"
    rounded: "{rounded.content}"
    padding: "6px 14px"
  button-outline:
    textColor: "{colors.text-tab}"
    typography: "{typography.mono}"
    rounded: "{rounded.content}"
    padding: "6px 14px"
  input-field:
    backgroundColor: "{colors.bg-code}"
    textColor: "{colors.bone-ink}"
    rounded: "{rounded.content}"
    padding: "6px 10px"
  pill-status:
    typography: "{typography.mono}"
    rounded: "{rounded.pill}"
    padding: "2px 10px"
  chip-risk:
    typography: "{typography.mono}"
    rounded: "{rounded.content}"
    padding: "1px 6px"
  badge-count:
    textColor: "{colors.ochre}"
    typography: "{typography.mono}"
    rounded: "{rounded.pill}"
    padding: "0 6px"
  lane-row:
    rounded: "{rounded.row}"
    padding: "8px 18px 8px 13px"
---

# Design System: Switchboard

## Overview

**Creative North Star: "The Engraved Score"** (candidate 7 of 7, seed `157f7fe9`)

The thesis, recorded verbatim at the top of `src/renderer/App.vue`: nine concurrent
agents are parts in one score, not rows in a list. The sidebar is not a list of
projects with status badges; it is a score's margin, and each project is a braced
part read against a single shared time axis. A held lane does not
show a spinner or a badge — it carries a fermata, the mark a conductor draws over
a note that must not resolve until someone releases it. The story the interface
tells: the developer reads every lane at once, believes the held lane is the only
one wanting them, and releases its fermata.

The material follows from the metaphor rather than decorating it. The ground is
an engraver's pewter plate (`#2b3037`), not a screen — flat metal under one raking
light from the top left, with a bottom vignette giving the sheet its edge. Ink is
bone (`#e8e4dc`), warm against the cool plate on purpose, because ink and metal
are different materials and should not read as one. Depth is a hairline lip of
light on a plate edge, never a cast shadow, and corners are cut straight (a 3px
radius) because a plate is scored with rules, not moulded with curves. Three
accents come from score production itself and never from decoration: proof cyan
is the live now-line and every "play on" action, ochre is the conductor's cue
mark for a decision owed, and oxblood is a struck-out bar. A finished lane earns
no hue at all — it draws a double barline.

This is a deliberate refusal of the category's usual dashboard: a sidebar list
plus a stream pane. It replaces that reading with one where every project is
visible against the same clock at the same time, and the one thing that moves
without being asked is the now-line itself.

**Key Characteristics:**

- Every project is a braced part read against one shared now-line, not a row with a badge.
- State is drawn as real music notation (fermata, beamed note, double barline, struck bar, rest), never as a coloured dot.
- The plate is metal, not glass: flat colour, a raking highlight, a bottom vignette, no blur, no translucency stack borrowed from the previous world.
- Straight corners (3px) everywhere content lives; full round (99px) is reserved for things that report a value.
- One authored motion, the now-line's slow breath, shared across every lane so it reads as a single rule crossing the score.
- Part identity is a 1px brace, never a coloured edge bar.

## Colors

Three semantic accents, all drawn from score production rather than from generic
"success/warning/danger" language, plus one identity-only hue. Token *names* in
the CSS (`--green`, `--amber`, `--red`, `--teal`) are unchanged from the previous
"Glass Switchboard" world so all seventeen consuming files kept working through
the rebuild — only the values moved. Reading `--green` as "the emerald action
colour" or `--teal` as "brass" is reading the old world; both names now hold
different hues entirely, documented below under their real identities.

### Primary

- **Proof Cyan** (`#57b9cf`, `--green` / `--blue`): the now-line and every action
  that makes a lane play on — the primary button fill, the working state, the
  focus outline on every input, text selection. Working *is* playing, so the
  working state takes the now-line's own hue rather than a fourth colour: action
  and state differ in form here, never in hue. 5.85:1 against the plate.

### Secondary

- **Ochre** (`#e0a760`, `--amber`): attention owed — a lane is held, awaiting a
  decision. **This is a contract amendment.** The original direction named this
  role "rehearsal red." It could not survive: on the dark plate, both the
  attention colour and the error colour had to be lightened to clear the
  contrast floor, and once both were light they sat only 27° of hue and 1.2:1 of
  contrast apart — the two most important state signals in the interface became
  mutually indistinguishable. Ochre is still score material (cue letters and
  rehearsal marks are genuinely warm on an engraved plate), and it restores
  separation from oxblood. Legibility of state beat thematic purity. 6.24:1, hue
  33. **Do not use the word "red" for this role anywhere; it is not red.**
- **Oxblood** (`#f0776a`, `--red`): a struck-out bar, and every destructive
  action — errors, the stop control, high-risk chips, denied decisions, delete.
  This is the one colour convention the product must not break, so it stayed
  where the previous world had it, only lightened to clear contrast. 4.78:1, hue
  6.

### Tertiary

- **Viol Blue-Violet** (`#8f9fd8`, `--teal`): the continuo — the figured-bass
  line where MCP and the database live. **This is the second contract
  amendment: the word "brass" must be dropped everywhere for this token.** The
  previous value was a warm brass (`#b08d57`) sitting only 4° of hue from the new
  Ochre above, which would have conflated "this needs you" with "this is the
  database project." A viol is a different instrument family from a cue mark, so
  the hue moved to a cool blue-violet to separate cleanly. 5.14:1, hue 227.
- **Brace Violet** (`#bb8fd0`, `--purple`): identification only, never state.
  Colour-codes a project's brace and its sidebar group so a lane is recognisable
  even in the collapsed rail, where two initials are all the identity a project
  has. 5.03:1.

### Neutral

- **Engraver's Pewter** (`#2b3037`, `--bg`): the plate itself, the true ground.
  Sits a clear step below the panes it holds — at near-equal values the panes
  read as one flat field with no seam, which measurably failed on screen.
- **Bone Ink** (`#e8e4dc` down through `#9c968d`): the ink ramp printed on the
  plate. Five tiers carry real content and all clear 4.5:1 against `#2b3037`:
  Bone Ink Strong `#e8e4dc` (10.48:1, names and titles), Body `#bcb8b0` (6.72:1,
  prose), Meta `#a8a39a` (5.30:1, secondary lines, timers, counts — shared with
  Faint), Tab `#a09b92` (4.81:1, inactive controls), and Ghost `#9c968d` (4.53:1,
  the faintest readable tier — shared with Noise and Label). A handful of
  further sibling tiers exist in code between these five (Bright, Title, Name,
  Prompt, Mid) at near-identical values; they are not separately catalogued
  here because they do not carry a distinct role.
- **Staff Hairline** — **removed.** The five ruled hairlines were the world's
  original defining visual and are gone. Their history is worth keeping, because
  it is a lesson rather than a deletion: a first cut at 0.13 alpha in a 0.55
  container was an effective 7% line that verified invisible at 4x zoom, so the
  density was raised to 0.3 in a 0.8 container and verified as five discrete
  rules. Rendered honestly at that density, at 252px behind 12px text, they read
  as guitar strings rather than as a staff. A visual that only works when it is
  too faint to see is not working. The lane's identity now rests on its brace,
  its notation mark, and the now-line.
- **Border** (`rgba(232,228,220,0.1)`) and **Border Strong**
  (`rgba(232,228,220,0.2)`): every rule scored into the plate, from card edges
  to input strokes.
- **Panel** (`rgba(30,34,39,0.94)`) and **Card** (`rgba(38,43,49,0.7)`): the
  sidebar/composer tier and the content-object tier respectively, both dense
  rather than glassy — an engraving plate is metal, not glass.

### The Proof Sheet (light theme)

`html.sb-light` is a genuine second theme, not a filter over the dark one: the
same engraving pulled as a proof on cool blueprint paper (`#f4f5f7`), ink turned
graphite (`#16191d`–`#22262b`), and all three accents darkened so they still hold
contrast on paper rather than staying at their dark-plate lightness. Proof Cyan
becomes `#1f6a7d`, Ochre becomes `#a8331f`, Oxblood becomes `#6b241c` (~10:1 on
paper), and the continuo becomes `#7d5a22` — a genuinely different value per
theme, not a shared token run through a brightness filter.

### Named Rules

**The Two-Track Wash Rule.** Every translucent wash and accent border derives
from its solid token by construction — `color-mix(in srgb, var(--token) N%,
transparent)` — never a hardcoded rgba hue. Verified at 127 declarations across
14 files in `src/renderer`, with zero raw legacy accent hex triplets remaining
anywhere in the renderer. Retuning a token therefore reaches every wash that
derives from it automatically; this is why the two contract amendments above
could each move a single hex value and correctly repaint the entire interface.

**The Fine Gets No Hue Rule.** A finished lane draws a double barline in neutral
ink, not a "success green." Only three states carry colour — held (ochre),
playing (proof cyan), and struck (oxblood) — and "finished" is deliberately
colourless so it does not compete with a state that still needs the developer.

## Typography

**Display Font:** none. The instrument panel has no display tier, unchanged from
the previous world.
**Body Font:** a system UI stack (`system-ui, -apple-system, 'Segoe UI',
sans-serif`).
**Score Font:** Georgia (bold italic), for score terms — engraved dynamics
genuinely are bold italic serif in real notation.
**Label/Mono Font:** JetBrains Mono, for terminal output and command text only.

**Character:** the previous world's Instrument Sans was deliberately removed —
it is a known training-data default face — in favour of the operating system's
own UI font, so the chrome recedes rather than asserting a typographic identity
of its own. Georgia is reserved for the vocabulary of the score itself (terms
like "fermata," "tacet," "fine"), so the one serif in the interface is doing a
specific, earned job rather than adding warmth generally.

### Hierarchy

Verified by direct count in `src/renderer` at the time of writing (font-size
declarations, all sizes on the system sans stack unless noted):

- **Meta** (400, 10.5px): the most-used size, 65 declarations. Secondary lines, timestamps, pills, footer readings.
- **Mono** (400–600, 11.5px, JetBrains Mono): 55 font-size declarations at this step, of which 20 explicitly set `font-family: var(--mono)` — commands, raw output, and button/pill/chip/badge text. The remainder at this size stay on the sans stack.
- **Label** (400, 11px): 51 declarations. Only one of these carries the 0.08em uppercase tracking that originally defined the role (the sidebar's `PROJECTS` heading); the six inherited views use their own section-heading tracking values (0.04em–0.18em) rather than one shared convention. Recorded as observed, not prescribed.
- **Caption** (400, 10px): 48 declarations. Sub-labels, chip text, agent lines.
- **Micro** (400, 9.5px): the floor of the system, 22 declarations. Section rules, provenance lines, and tags that must be legible without competing with the line they annotate. Never used for anything the reader has to read in sequence. There is no step below this and no 9px near-duplicate: a second micro size the eye cannot tell apart is a ramp with a hole in it, not a finer tier.
- **UI** (400, 12px): 46 declarations. Control and row labels.
- **Body** (400, 13px, 1.6): 25 declarations, and the base size on `html`, so 13px is the default rather than a step down.
- **Body Compact** (400, 12.5px, 1.6): 20 declarations. Dense prose inside cards.
- **Title** (700, 13.5px, 0.02em): 6 declarations. Brand lockup and view headers.
- **Headline** (600, 15.5px, 1.3): 1 declaration — the remove-project dialogue title, and the ceiling of the system.

**Glyph sizing is not type sizing.** Icon and symbol glyphs (fold carets, the
`▣` logo mark, dialogue icons) are sized to optical weight, not to this ramp,
and fall outside it by design.

### Named Rules

**The Earned Monospace Rule.** JetBrains Mono is for content that is genuinely
code, a command, a path, or terminal output — plus the button/pill/chip idiom
that borrows its voice. The `.mono` CSS *class*, confusingly, resolves to the
sans face (`font-family: var(--sans)`); it is a historical name kept for the 115
call sites still using it, and reaching for it expecting monospace is the
mistake this rule exists to name.

**The Unwired Score Face.** `--serif` (Georgia bold italic) is declared as a
token and named in the direction contract for "score terms," but no component in
`src/renderer` currently applies `var(--serif)` — the fermata/tacet/fine
vocabulary only appears in `title` attributes and ARIA labels (`markTitle()` in
`Sidebar.vue`), which render in the browser's own UI font, not Georgia. Record
this as an open commitment: the serif face exists in the palette but has no
visible expression yet.

## Layout

Unchanged in structure from the previous world: a fixed three-pane desktop
window with no responsive behaviour of any kind — zero `@media` queries anywhere
in the renderer, and `.panes` carries an explicit `min-width: 1080px`. The
sidebar is 252px expanded, 64px collapsed by a user toggle rather than a
breakpoint; the centre pane holds the session stream and its bottom-pinned
composer; the inbox pane is drag-resizable between 280px and 680px.

Rhythm is unchanged and tight: rows carry roughly 8px by 13–18px padding, panes
pad 11px to 22px depending on how much chrome they own, and the recurring
spacing steps are 4, 6, 8, 10, 14, 18, and 22px. The sidebar must show every
project without scrolling wherever possible, so a row earns a second line only
when it is the selected one.

List headings stay sticky and stack: the `PROJECTS` heading pins at the top of
the scroll container and each group heading pins 31px beneath it, so the group a
lane belongs to is still named after its header has scrolled past.

## Elevation & Depth

The system deliberately **removed the previous world's glass stack**
(`backdrop-filter: blur(...)` on panes and sticky headings) and replaced it with
opaque, layered plates. A plate does not emit or refract light; it catches it.
Read the stack back to front:

1. **The lit ground.** `body` carries one 158° raking highlight and a bottom
   radial vignette (`rgba(0,0,0,0.22)`), resolving to the plate colour. No glow
   pools remain from the previous world — a plate does not emit.
2. **Panels** (`--bg-panel`, 0.94 alpha). The sidebar and composer. Dense rather
   than glassy, and a clear step below the plate's own darkness so the seam
   between plate and panel reads.
3. **Sticky headings** (`--bg-sticky`, 0.97 alpha). Denser again than the panel
   they float within, because rows pass directly beneath them.
4. **Cards** (`--bg-card` / `--bg-card-alt`, ~0.66–0.7 alpha). Content objects
   within a panel.
5. **Overlays.** A scrim at `rgba(20,23,26,0.72)` with a 4px blur covers
   everything; the dialogue above it is the only tier permitted a real cast
   shadow (`0 32px 80px rgba(0,0,0,0.62)`).

`--elev` is a 1px inset highlight plus a 1px drop shadow — a lip of light on a
plate edge, not elevation. `--gloss` is a deliberate no-op transparent gradient
in the dark theme; on the proof sheet it becomes a genuine white sheen
(`rgba(255,255,255,0.14)`), because paper catches light where metal does not.

### Named Rules

**The Earned Shadow Rule**, carried forward from the previous world and still
true: only the overlay tier casts a real shadow. A card that wants to lift off
its panel is asking for the wrong tier.

## Shapes

`--rc` is **3px**, not the previous world's 10px. This is the single loudest
signal of the rebuild: a plate is cut with straight rules and sharp edges, so
almost everything that contains content — cards, dialogues, inputs, buttons,
chips, the risk-chip family — takes this one corner value. Confirmed at 95
`var(--rc)` references across 17 files.

Three exceptions, all deliberate and unchanged in principle from before:
interactive list rows use 8px, a step looser, because a row is a target rather
than a container; small bare-glyph hover patches (the `+`/`▤` controls, a
drop-target highlight) use 6px; and colour swatches of 6px or less use a 2px
micro radius, which softens a tiny square without rounding it into a dot.

Anything that reports a value rather than containing content goes fully round
at 99px: count badges, status pills, the settings toggle and its knob, the
usage meter and its fill, and the MCP connection dot (which explicitly forces
`border-radius: 50% !important` to override the corner reset).

**Known inconsistency, worth fixing rather than copying:** not every dot-shaped
status indicator was updated when `--rc` dropped from 10px to 3px. InboxView's
group status dot is 7px square with `border-radius: var(--rc)`, and its own code
comment still claims this "resolves to a full circle since --rc > half the box
size" — that was true at 10px but is false at 3px (3px is less than half of
7px), so it now renders as a rounded square. SessionView's header dot (`.h-dot`)
carries no `border-radius` at all and renders as a plain square. Both should
either move to an explicit `border-radius: 50%` (as the MCP dot and footer dots
already do) or be redrawn as notation, matching the sidebar's own signature
component below.

Borders are uniformly 1px, drawn in translucent bone ink. A dashed border is
reserved for a transient drag-and-drop affordance, where a dashed proof-cyan
outline marks a drop target.

## Components

**Character: instrument first, chrome second.** Controls stay close to
invisible until the pointer reaches them — remove buttons sit at `opacity: 0`
until their row is hovered, bare glyph controls carry no chrome at rest. Colour
is spent on state, identity, and the now-line; everything else is grey ink on
grey plate.

### Buttons

- **Shape:** one 3px radius (`--rc`) across every variant.
- **Primary** (`.btn-solid`, `.send-btn`): a 135° proof-cyan gradient (flat
  colour on the proof sheet, where `--gloss` is a no-op) at 11.5px JetBrains
  Mono, weight 600, 6px by 14px padding, carrying a cyan action-glow shadow.
- **Hover:** the gradient flattens to `--green-hover`, a brighter flat cyan.
- **Armed** (`.btn-armed`): the same geometry filled ochre, for the second step
  of a destructive confirmation. Enters with `sbIn` so the state change is
  visible.
- **Outline** (`.btn-outline`): transparent with a strong hairline border and
  tab-tier text; hovering turns the border and text oxblood, making outline the
  cancel-and-destroy idiom rather than a neutral secondary.
- **Quiet** (`.btn-quiet`): identical geometry, hovering to a proof-cyan border
  and brighter text — the true neutral secondary.

### Chips

- **Risk chips** (`.chip-risk`): 10px mono, 3px radius, 1px by 6px padding. Low
  is a bare hairline border; medium adds ochre text and border; high adds a
  faint oxblood wash behind an oxblood border, escalating visual weight across
  three readable steps.
- **Marker chips** (`.chip-marker`): the decision record in the stream —
  approved is proof cyan on a 7% wash, denied is oxblood, pending is ochre,
  expired falls back to a bare border.
- **Count badge** (`.badge-count`): ochre text on a 13% ochre wash with a 35%
  border, fully round, `white-space: nowrap`. The loudest small element in the
  interface — correctly, since it counts decisions a human owes.

### Cards / Containers

- **Corner Style:** 3px (`--rc`).
- **Background:** Card tier, `var(--gloss), var(--bg-card-alt)`, so the proof
  sheet's sheen appears without the plate changing.
- **Shadow Strategy:** hairline lip only; see Elevation & Depth.
- **Border:** 1px translucent bone ink, stepping to Border Strong on hover.
- **Internal Padding:** 8px by 10px for list-row cards, 16px for dialogues, 24px
  for the one dialogue carrying a warning (remove-project).

### Inputs / Fields

- **Style:** code-plate background (`--bg-code`), Border Strong, 3px radius,
  6px by 10px padding, the 13px sans body face.
- **Focus:** a 1px proof-cyan outline — the only focus treatment in the system,
  applied globally to inputs, textareas, and selects.
- **Filter field:** a variant with no fill, whose border turns proof cyan both
  on focus and whenever a query is active.
- **Inline rename:** plate background with a full proof-cyan border, marking
  the field as a live edit of the row it replaces.

### Navigation: the score margin

Navigation is the sidebar's project list, not a nav bar, and it is where the
score grammar lives. This grammar belongs to `Sidebar.vue` alone — the other six
views (SessionView, InboxView, McpView, SpecsView, TestsView, EvalsView,
CleanupView) inherited the plate/ink/accent token layer only and carry no
staff, brace, or notation-mark grammar of their own.

- **The staff:** removed. See Colors. A lane is now unruled plate carrying three
  marks, and the brace does the work of saying "this is a part".
- **The now-line** (`.now`): one per lane, at the same right-edge offset, so it
  reads as a single rule crossing every staff at once. Only drawn while
  something is playing (`projects.counters.running > 0`), and animated with one
  shared 3.2s breath (`nowBreath`) rather than a per-lane animation, so the
  breathing reads as one authored moment rather than nine independent ones.
- **The brace** (`.brace`): part identity as a 1px SVG stroke in the project's
  accent colour, not a coloured edge bar — a coloured border above 1px on a
  list item is exactly the habit this world refuses (see the previous world's
  2px accent bar, now removed).
- **Lanes are keyboard-operable:** `tabindex`, Enter, and Space all select a
  project, with an inset focus ring (`box-shadow: inset 0 0 0 1px var(--green)`)
  that never shifts the lane's geometry.

### Signature Component: the notation mark

The lane's current state, drawn as real music notation at 16×14, inline SVG,
never a font glyph:

- **Fermata** (needs you): a half-circle over a dot, ochre.
- **Beamed note** (working): a filled notehead with a stem and beam, proof cyan.
- **Struck bar** (error): a vertical bar crossed through, oxblood.
- **Bar rest** (tacet/ended): a thick-over-thin double rule, ghost-tier ink.
- **Double barline** (fine/done): two bars of differing weight, deliberately no
  hue at all.

Every mark is named in plain language for hover and screen readers via
`markTitle()` (e.g. "Fermata — held, needs you"), so the metaphor never gates
comprehension for a developer meeting the notation for the first time. Unlike
the previous world's status dot — whose pulsing halo (`sbGlow`) was the whole
of its signature — **no mark itself carries motion**. Colour and shape alone
distinguish state; the now-line is the score's only moving part, which is a
deliberate departure from the earlier "motion means busy or waiting" rule. (The
shared `.dot` / `.dot.working` / `sbGlow` block still exists in `styles.css` but
is no longer referenced by any template — every other view now rolls its own
local status dot; treat it as dead CSS rather than the system's real idiom.)

## Do's and Don'ts

### Do:

- **Do** call the attention-owed colour Ochre, never red. It sits at hue 33; the
  error colour Oxblood sits at hue 6, and the two must stay separated.
- **Do** treat `--rc` (3px) as the corner for anything that contains content,
  8px for interactive rows, and 99px for anything that reports a value.
- **Do** derive every wash from its solid token with `color-mix(in srgb,
  var(--token) N%, transparent)`. Never hardcode an accent rgba triplet.
- **Do** keep the now-line as the score's one shared, authored motion. A status
  mark should not animate on its own.
- **Do** keep JetBrains Mono for terminal output, commands, and the
  button/pill/chip idiom. Everything else is the system sans stack.
- **Do** add explicit dark and light values for any new token. The proof sheet
  is a real second theme with its own darkened accents, not a filter over the
  plate.

### Don't:

- **Don't** use the word "red" for the attention-owed role. That collision is
  exactly what the ochre amendment fixed.
- **Don't** describe the continuo/MCP token as brass. It is a viol blue-violet
  now; brass would describe a colour that no longer exists in this system.
- **Don't** reintroduce a coloured edge bar for part identity. A brace is a 1px
  stroke; anything thicker is the habit this world refused.
- **Don't** reintroduce `backdrop-filter` blur on panels or sticky headings.
  The plate is opaque metal, not the previous world's glass.
- **Don't** reinstate five ruled hairlines across a lane. They were tried at two
  densities: too faint to see, or reading as guitar strings behind the text. If a
  lane ever needs staff character, a single rule is the honest form, because a
  percussion staff genuinely uses one line.
- **Don't** add a media query or a percentage-based breakpoint. The target is
  one fixed desktop window (`min-width: 1080px` on `.panes`), and the sidebar
  collapse is a user toggle, not responsive behaviour.
- **Don't** present the Approve/Deny decision as living on the lane itself —
  it doesn't yet. The direction contract's "a held lane carries its decision
  inline, never in a distant pane" is unmet: those controls still live in
  `InboxView.vue`, a separate pane from the sidebar's score margin.
