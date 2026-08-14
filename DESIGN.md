---
name: Switchboard
description: An instrument screen for supervising several Claude Code sessions, where colour is spent only on a reading outside tolerance.
colors:
  ground: "#14161A"
  ground-panel: "#101216"
  ground-sticky: "#0C0E11"
  card: "#1A1D22"
  card-alt: "#171A1F"
  code-surface: "#0E1013"
  graticule: "rgba(221, 225, 230, 0.12)"
  graticule-strong: "rgba(221, 225, 230, 0.3)"
  text-bright: "#F2F5F8"
  text-body: "#DDE1E6"
  text-mid: "#9AA2AC"
  text-meta: "#868F9A"
  trace-green: "#3FBFB4"
  trace-green-hover: "#57D6CB"
  tolerance-amber: "#E0A458"
  tolerance-red: "#E0685E"
  identity-teal: "#6FA8DC"
  identity-purple: "#A98BD6"
  ground-light: "#F7F8FA"
  card-light: "#FFFFFF"
  text-light-body: "#23272D"
  trace-green-light: "#12766E"
  tolerance-amber-light: "#8A5A12"
  tolerance-red-light: "#A3282A"
typography:
  ui:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', 'Inter', sans-serif"
    fontSize: "12.5px"
    fontWeight: 500
    lineHeight: normal
  body:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', 'Inter', sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  title:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', 'Inter', sans-serif"
    fontSize: "17px"
    fontWeight: 500
  head:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', 'Inter', sans-serif"
    fontSize: "20px"
    fontWeight: 500
  meta:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', 'Inter', sans-serif"
    fontSize: "11px"
    letterSpacing: "0.08em"
  machine:
    fontFamily: "'JetBrains Mono', ui-monospace, 'Cascadia Mono', Consolas, monospace"
    fontSize: "13px"
    fontVariantNumeric: tabular-nums
rounded:
  card: "3px"
  pill: "2px"
  square: "0px"
spacing:
  1: "4px"
  2: "6px"
  3: "8px"
  4: "10px"
  5: "13px"
  6: "16px"
  7: "22px"
components:
  button-primary:
    backgroundColor: "{colors.trace-green}"
    textColor: "#0E1013"
    typography: "{typography.ui}"
    rounded: "{rounded.card}"
    padding: "6px 14px"
  button-primary-hover:
    backgroundColor: "{colors.trace-green-hover}"
  button-armed:
    backgroundColor: "{colors.tolerance-amber}"
    textColor: "#14161A"
    typography: "{typography.ui}"
    rounded: "{rounded.card}"
    padding: "6px 14px"
  button-outline:
    backgroundColor: transparent
    textColor: "{colors.text-mid}"
    typography: "{typography.ui}"
    rounded: "{rounded.card}"
    padding: "6px 14px"
---

# Design System: Switchboard

## Overview

**Creative North Star: "The Trace"**

The Trace is an instrument screen, not a console and not a dashboard. It refuses the console-with-one-neon-accent register and the white-card-dashboard register alike, and it refuses its own predecessor, The Sixteen-Colour Field, an indexed sixteen-ink palette with a bitmap face that could not render below 12px and cost the board its density on a populated screen. The ground is neutral charcoal, ruled by a faint graticule of hairline borders; the interface is otherwise monochrome, and the one accent colour marks the live trace. Every other colour that appears is a reading outside tolerance, never decoration.

The build is dense by requirement, not by style preference: PRODUCT.md fixes information density as a structural constraint, because the application is watched for hours with several sessions in flight, and it must hold six lanes, a branch, a filesystem path, a timer and a count on one row without truncating. That is the exact fault that killed the previous world, so this one returns to an 11px floor on a system typeface with real weights, rather than a display face with a legibility floor.

PRODUCT.md's Brand Commitments state plainly that no visual register is binding: palette, typeface, corner geometry, rule weight, density and elevation are all replaceable, and this record describes the current build, not a locked identity. Two prior worlds, The Engraved Score and The Deployable Sheet, and the sixteen-ink world named above, are rejected and stand only as anti-reference; nothing from them survives in the build and nothing here should be read as reviving them.

**Key Characteristics:**
- Neutral charcoal ground (never navy, never pure black) under a faint hairline graticule.
- One accent, a teal-green trace colour, reserved for action and running state.
- Every other colour is earned by being out of tolerance: amber for attention owed, red for error.
- A system UI typeface throughout, 11-20px; monospace reserved for machine text where the character grid carries meaning.
- Materials are flat: a hairline lip for depth, no gradients, no glows, no bevels.

## Colors

The palette is neutral-charcoal-and-hairline at rest, with colour spent only where a reading needs it.

### Primary
- **The Trace** (`#3FBFB4` dark / `#12766E` light): the one accent. Marks the live/running/action state — the send button, the working pill, approved markers, links, focus rings, the caret. It is the only warm-saturated colour on a board where nothing is wrong.

### Secondary
- **Tolerance Amber** (`#E0A458` dark / `#8A5A12` light): "needs you" / attention owed. Used for the amber pill, medium-risk chips, pending markers, the count badge.
- **Tolerance Red** (`#E0685E` dark / `#A3282A` light): error / high risk / denied. Held apart from amber so a hard fault never reads as merely attention-owed.

### Tertiary
- **Identity Teal** (`#6FA8DC`) and **Identity Purple** (`#A98BD6`): identity-only accents (e.g. the Database MCP surface), kept clear of the trace-green hue so an identity marker is never mistaken for a running session.

### Neutral
- **Ground** (`#14161A` dark / `#F7F8FA` light): the base charcoal/near-white field.
- **Panel** (`#101216` dark / `#EEF0F3` light) and **Card** (`#1A1D22` dark / `#FFFFFF` light): the two surface tiers, stepped darker/lighter than the ground.
- **Graticule border** (`rgba(221,225,230,0.12)` dark / `rgba(20,22,26,0.14)` light): the hairline rule that draws every division. Never the loudest thing on screen.
- **Text tiers**: bright (`#F2F5F8`), body (`#DDE1E6`), mid (`#9AA2AC`), meta (`#868F9A`) dark; mirrored tighter on light. Each tier is measured against the ground it lands on, floor 4.5:1.

### Named Rules
**The Tolerance Rule.** Colour is spent solely on a measurement outside tolerance. A board with nothing wrong is monochrome except for the one live trace; amber and red are earned by an actual reading, never applied for emphasis or decoration.

**The Fine Gets No Hue Rule.** A finished lane draws no colour, so it cannot compete for attention with a lane that still needs the developer. `.pill.done` is neutral ink, not green, even though green is otherwise the "good" colour elsewhere in the system.

**The Identity-Never-State Rule.** Teal and purple identify a surface (e.g. a database connection); they never report status. Status colours are exactly trace-green, amber and red.

## Typography

**Body/UI Font:** `system-ui, -apple-system, 'Segoe UI', 'Inter', sans-serif` (a system stack)
**Machine Font:** `'JetBrains Mono', ui-monospace, 'Cascadia Mono', Consolas, monospace`

**Character:** A plain system UI face carries every label, name, status and button; monospace is reserved for text where the character grid is load-bearing. The pairing is deliberately unglamorous: the previous world's single-weight bitmap face forced every tier a step larger and cost the board its density, so this system favours a face with no legibility floor at small sizes and real weight variation (400/500).

### Hierarchy
- **Head** (500, 20px): section headers.
- **Title** (500, 17px): panel and dialog titles.
- **Body** (400, 13px, line-height 1.5): stream content, composer text.
- **UI** (500, 12.5px): buttons, labels, tabs, the bulk of interface chrome.
- **Meta** (400, 11px, 0.08em tracking on labels): pills, chips, timers, badge counts.
- **Micro** (400, 11px): the smallest chips and the stop-control glyph.
- **Machine** (JetBrains Mono, matches surrounding size, tabular figures): code, diffs, raw terminal output, filesystem paths, ids/hashes, and any ticking figure (timers, costs, token counts) that must hold its column.

### Named Rules
**The Monospace Is Earned Rule.** `.mono`/`.code` are applied only where the character grid carries meaning: code, commands, paths, ids, diffs, and figures that tick. Labels, names, statuses, buttons and tabs are interface chrome and are set in the UI face. The system tried setting the whole interface in JetBrains Mono for one release; the measured verdict was that it read bulky and oversized, because a monospaced face runs roughly a tenth wider per character than a proportional one at the same size. That measurement, not a preference, is why the class was flipped back.

**The Legible-At-Density Rule.** No type tier may require a face with a legibility floor above roughly 11px. The board's row must hold a status mark, a project name, a branch, a path, a timer and a count without truncating; a type system that forces a larger floor to stay legible is disqualified regardless of how it reads on an empty screen.

## Layout

The build is a three-pane control room: a collapsible project sidebar on the left, the opened session/tabs in the centre, and an inbox/decisions rail on the right, with a status bar across the foot. PRODUCT.md fixes this composition as a structural constraint; it is not available to be redesigned away. Spacing follows a compact scale (4, 6, 8, 10, 13, 16, 22px), with card padding set from the 10px/13px steps (`--pad-card`). The composer pins to the bottom of the centre pane; stream content anchors to the bottom via `margin-top: auto` so a short conversation does not leave a tall empty gap above the input.

The measurement graticule named in the direction contract (a drawn grid across the panes) and per-lane stepping traces (idle flat, active stepping, so activity reads as shape before text) are **not yet built**. The graticule effect currently exists only as ordinary hairline borders between panels and rows, not as a drawn ruled surface, and the sidebar's project rows carry no stepping-trace visualisation. Record these as pending, not as shipped.

## Elevation & Depth

The system is flat with a hairline lip, not a shadow-driven or bevelled material. `--elev` is a 1px inset highlight only (`inset 0 1px 0 rgba(221,225,230,0.06)` dark), used for a barely-there top edge on raised surfaces. Real box-shadows (`--shadow-dlg`, `--shadow-dd`, `--shadow-menu`) are reserved for the overlay tier only: dialogs, dropdowns and menus that sit above the graticule plane. Every shadow in the system carries both an offset and a blur; a hard, zero-blur block shadow belonged to the rejected pixel-grid world and has no licence here. No gradients and no glows exist anywhere in the build (`--gloss: none`, `--green-glow: none`): a coloured glow was judged decoration rather than depth and was removed from every button that is not the composer's Send.

### Shadow Vocabulary
- **Elevation hairline** (`inset 0 1px 0 rgba(221,225,230,0.06)`): the only "depth" a flat panel or card gets.
- **Dialog** (`0 24px 60px rgba(0,0,0,0.55), 0 0 0 1px rgba(221,225,230,0.1)`): modal overlays only.
- **Dropdown/menu** (`0 12px 32px rgba(0,0,0,0.45)`): suggestion lists, context menus.

### Named Rules
**The Earned Shadow Rule.** A real, blurred box-shadow is granted only to the overlay tier (dialogs, dropdowns, menus), the one tier that sits above the graticule plane. Every other surface is flat with, at most, the elevation hairline.

**No Glow Rule.** A coloured shadow is elevation, and elevation says "this is the one thing to do here." It is reserved for the composer's Send button and nothing else. `--green-glow` exists as a token but resolves to `none` almost everywhere it could be applied.

## Shapes

Corners are barely radiused, not hard-square and not softly rounded: cards and controls use a 3px radius (`--rc`), small chips and switches use 2px (`--rp`), and a few deliberately-flat elements (the composer input, machine-text blocks) use 0px (`--sq`). This is a middle position: the direction contract calls the interface "crisp," but a hard 0px radius on every card was judged too severe for a modern, readable instrument panel. Borders throughout are 1px hairlines drawn from the graticule tokens; there is no bevel, no stamped/embossed edge, and no cut-corner clip-path outside the dialog surface, which alone carries an 8-10px notch cut via `clip-path` on its background pseudo-element.

## Components

### Buttons
- **Shape:** 3px radius (`--rc`), no border on the solid/armed variants.
- **Primary (`.btn-solid`):** trace-green fill, dark ink text, 500 weight, 12.5px, `6px 14px` padding. Hover swaps to a flatter, brighter green; no gradient or gloss layer in this world.
- **Armed (`.btn-armed`):** amber fill, used for a confirmation step on a high-risk action; entrance animates in (`sbIn`, 0.2s).
- **Outline / Quiet (`.btn-outline`, `.btn-quiet`):** transparent background, 1px strong-border, mid-tone text; outline's hover reddens toward a destructive action, quiet's hover greens toward an affirmative one.
- **Disabled:** every solid/armed/outline/quiet/segment button drops to 0.45 opacity with a default cursor, and its hover rule is suppressed so a disabled control cannot light up under the pointer.

### Chips (used)
- **Risk chips (`.chip-risk`):** low is a neutral outline, medium is amber, high is red with a light red wash background, plan is blue/amber (identical token). 1px border, 11px text.
- **Marker chips (`.chip-marker`):** approved/rule-approved (green), denied (red), pending (amber), expired (neutral outline) — each a coloured 1px border over a faint matching wash.

### Cards / Containers
- **Corner Style:** 3px radius.
- **Background:** the card tier (`--bg-card`), one step lighter than the panel it sits on (dark) or pure white on a cool-grey ground (light).
- **Shadow Strategy:** none; flat, per Elevation & Depth.
- **Border:** 1px, `--border-card`.
- **Internal Padding:** `--pad-card` (10px vertical, 13px horizontal).

### Inputs / Fields
- **Style:** 1px strong border, `--bg-code` background, 3px radius, `6px 10px` padding.
- **Focus:** a 1px trace-green outline ring; the composer's own multi-line field is exempt from an outline override so the shared rule reaches it, since it is the field every message to Claude is typed into.
- **Composer-specific:** block caret in trace-green, monospace type (earned: slash commands, `@paths`, shell lines), an inline ghost-text mirror for autocomplete, and an upward-opening suggestion dropdown with the dropdown shadow.

### Navigation
- **Sidebar rows:** system-UI face, mono only for names/paths where alignment matters; a status "fold mark" glyph substitutes for a coloured dot; rows expand to show a branch/timer line when selected or still running.
- **Tabs (`.pt`):** selected tab takes a 2px inset bottom rule in trace-green (`box-shadow: inset 0 -2px 0 var(--green)`), not a border property, so it does not shift layout.

## Do's and Don'ts

### Do:
- **Do** reserve colour for a reading outside tolerance: trace-green for action/running, amber for attention owed, red for error. A monochrome board is the correct default state.
- **Do** set every label, button, tab and status string in the system UI face; reserve monospace for code, paths, ids, diffs and ticking figures.
- **Do** keep shadows flat except at the overlay tier (dialog, dropdown, menu), and always pair an offset with a blur when a shadow is used.
- **Do** hold identity colours (teal, purple) clear of the status colours (green, amber, red) so an identity marker can never be misread as a state.

### Don't:
- **Don't** add a gradient, a gloss layer, or a coloured glow to any button or panel. `--gloss` and `--green-glow` are both `none` throughout the build.
- **Don't** revive the sixteen-ink indexed palette, the DotGothic16 bitmap face, ordered dither, hard block shadows, bevelled edges, 0px card radii, or a 12px+ type floor. That world was built and explicitly rejected; PRODUCT.md records it as anti-reference, not as a style to draw from.
- **Don't** treat a 2px coloured border-left/inset rule as a system pattern for "selected." It appears on a few rows (see below) as a carried-over defect from an earlier world, not as an established selection idiom; the craft floor for this world holds selection marks to 1px.
- **Don't** promise a drawn measurement graticule or per-lane stepping traces as shipped behaviour. Neither is built; both remain plain hairline borders and static rows respectively.

---

**Not canonized:** several selection states (`Sidebar.vue` `.sub-line.sel`, `SpecsView.vue` `.pt.sel`) still draw a 2px coloured inset rule to mark "selected," which predates this world and is thicker than the 1px hairline discipline the rest of the build follows. It is recorded above as a known carry-over defect, not written into the Components or Shapes sections as a system rule, because canonizing it would turn one unfixed inconsistency into a pattern future surfaces are told to repeat.
