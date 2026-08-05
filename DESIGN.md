---
name: Switchboard
description: A Miura-fold sheet, scored and folded flat, deployed by one pull.
colors:
  sheet-carbon: "#17181B"
  sheet-white: "#F6F4EF"
  panel-carbon: "#131417"
  panel-paper: "#EFEDE6"
  card-carbon: "#1D1F23"
  card-paper: "#FCFBF7"
  code-plate-carbon: "#141518"
  code-plate-paper: "#F1EFE8"
  border: "rgba(244,244,242,0.11)"
  border-strong: "rgba(244,244,242,0.22)"
  ink-bright: "#F4F4F2"
  ink-primary: "#E6E5E1"
  ink-body: "#B7B6B0"
  ink-tab: "#9B9A94"
  ink-ghost: "#97968F"
  ink-on-wash: "#AEADA6"
  foil-green: "#4DC97E"
  foil-green-hover: "#6FD695"
  foil-green-ink: "#17181B"
  valley-blue: "#8CB8E4"
  valley-blue-ink: "#17181B"
  red-pencil: "#E8705C"
  red-pencil-ink: "#17181B"
  graphite-steel: "#8FB0C4"
  identity-violet: "#A99BD0"
  mountain-gray: "#B9B6AE"
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
  bodyCompact:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "12.5px"
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
  micro:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "9.5px"
    fontWeight: 400
  mono:
    fontFamily: "'JetBrains Mono', ui-monospace, 'Cascadia Mono', Consolas, monospace"
    fontSize: "11.5px"
    fontWeight: 600
rounded:
  content: "0px"
  pill: "0px"
  row: "8px"
  glyph: "6px"
  swatch: "2px"
spacing:
  xxs: "2px"
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "13px"
  2xl: "14px"
  3xl: "18px"
  4xl: "22px"
  5xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.foil-green}"
    textColor: "{colors.foil-green-ink}"
    typography: "{typography.mono}"
    rounded: "{rounded.content}"
    padding: "6px 14px"
  button-primary-hover:
    backgroundColor: "{colors.foil-green-hover}"
  button-armed:
    backgroundColor: "{colors.valley-blue}"
    textColor: "{colors.valley-blue-ink}"
    typography: "{typography.mono}"
    rounded: "{rounded.content}"
    padding: "6px 14px"
  button-outline:
    textColor: "{colors.ink-tab}"
    typography: "{typography.mono}"
    rounded: "{rounded.content}"
    padding: "6px 14px"
  input-field:
    backgroundColor: "{colors.code-plate-carbon}"
    textColor: "{colors.ink-primary}"
    rounded: "{rounded.content}"
    padding: "6px 10px"
  chip-risk:
    typography: "{typography.mono}"
    rounded: "{rounded.content}"
    padding: "1px 6px"
  badge-count:
    textColor: "{colors.valley-blue}"
    typography: "{typography.mono}"
    rounded: "{rounded.pill}"
    padding: "0 6px"
  switch:
    backgroundColor: "{colors.border-strong}"
    rounded: "{rounded.pill}"
  lane-active:
    backgroundColor: "{colors.mountain-gray}"
    rounded: "{rounded.row}"
    padding: "8px 18px 8px 13px"
---

# Design System: Switchboard

## Overview

**Creative North Star: "The Deployable Sheet"** (candidate 4 of the grounded list, user-chosen over the roll's own assignment; seed `02478bcf`, recorded verbatim in the direction contract at the top of `src/renderer/index.html`).

The thesis is a sheet, scored and folded flat, deployed by one pull. It is a deliberate double refusal: not the dark-IDE-plus-neon default, not the white SaaS dashboard, and not this project's own previous world either, which drew every state as music notation (a fermata, a beamed note, a struck bar) and asked the developer to learn that vocabulary first. This world asks the developer to learn nothing. A fold is a cut, so nothing in the interface is rounded except three small point markers that are explicitly exempted because they are round for a different reason: a spinner rotates, and a connection light and a tally dot read better as dots than as squares.

The material is the same physical object in two lights, not two designs. In carbon fibre (`#17181B`), the ground reads as dense composite under a faint sixty-degree crease lattice; on warm paper (`#F6F4EF`), the same lattice is scored subtractively rather than caught in light, and at a *lower* alpha, because a dark hairline on a bright field carries roughly twice the step a pale one carries on carbon. The rule is that the two grounds read equally faint, not that they share a number. Three semantic accents carry meaning and meaning alone: foil green is the one action colour, for every action that deploys or advances a lane; valley blue is attention owed, meaning a lane is held and awaiting a decision; the red-pencil mark is a correction, meaning error. A finished lane earns no hue at all, drawing a locked fold instead of a coloured badge. Project identity is a separate concern from state and is carried by a third mechanism entirely, a one-pixel fold tick coloured from a six-way rotation that happens to reuse the same accent tokens (see Colors, Named Rules).

This build's own finish clause, written into the direction contract, states that "unreviewed and undocumented is unfinished." This document is that review. Where the contract's own language promised something the shipped code does not yet do, that gap is recorded here as open rather than smoothed over, most visibly in Typography's Named Rules and in Shapes.

**Key Characteristics:**

- Two token sets, one object: `html.sb-light` and `:root` are the same sheet under carbon-fibre and paper light, sharing all 17 files that consume the semantic accent tokens by name.
- Three accents carry state (foil green for action/working, valley blue for attention owed, red-pencil for error); a finished lane carries none.
- Corners are cut, not rounded: `--rc` and `--rp` are both `0px`, with three named, deliberate circle exceptions.
- Project identity is a 2px bar in the lane's own colour, running the full height of the lane on its own left edge, at full opacity on every lane rather than only the selected one. The lane itself floats: a sheet inset from both panel edges with the ruled hairlines gone. The 26px fold tick, the 1px ceiling and the inset edge rules that preceded it are all gone, by request rather than by drift.
- Every translucent accent wash is derived from its solid token with `color-mix()`, never a hardcoded accent `rgba()` triplet.
- Essentially no authored motion. The system's one animated signature from the previous world, a shared "now-line" breath, was deleted outright and nothing replaced it.

## Colors

Three accents plus one identity mechanism, all named for the fold-and-plate material rather than for generic "success/warning/danger" language. The token *names* in the CSS (`--green`, `--amber`, `--red`, `--teal`, `--purple`, `--blue`) are unchanged from the two previous worlds this codebase has carried, so all 17 files that reference them by name kept working through both rebuilds; only the values moved. Reading `--green` as "foil green" is correct for this world. The name and the hue agree again as of the amendment recorded under Primary, below, but they did not for two worlds, so treat the token comment as authority rather than the name.

### Primary

- **Foil Green** (`#4DC97E`, `--green`): the one action colour, and every action that deploys or advances a lane, the primary button fill, the focus outline on every input, text selection. Working *is* the action state, so the working status also takes this hue rather than a fourth colour. 8.43:1 against the carbon ground, computed with the WCAG relative-luminance formula against the current token value.

  **Contract amendment.** The direction contract at the top of `src/renderer/index.html` names foil *gold* in this slot, and the owner has since directed green. The amendment is recorded here and in the token's own comment rather than applied silently, following the Contract Amendment Rule below. The replacement luminance was matched to the gold it supersedes, 8.43:1 against 8.44:1, so this is a hue move alone and no other token needed retuning.

  The swap also resolves a collision the gold carried. Foil gold sat 37 degrees of hue from the red-pencil error mark, both of them warm, which is the same warm-on-warm failure that cost the contract's original ochre its slot at `--amber`. Foil green sits 135 degrees from red-pencil. The cost is on the other side: it sits 66 degrees from valley blue where the gold sat 164, though the two separate on saturation as well as hue, a saturated green against a pale desaturated blue. This project's own earlier green, `#3FB27F`, was the obvious candidate and was rejected on measurement: 6.67:1, which would have made the action colour the dimmest of the three accents, and only 57 degrees from valley blue.

### Secondary

- **Valley Blue** (`#8CB8E4`, `--amber`): attention owed, meaning a lane is held awaiting a decision. The token's own in-code comment records a contract amendment: the direction originally named a warm ochre mark for this role, and on the dark sheet ochre and the red-pencil error colour separated by only 27 degrees of hue and 1.2:1 of contrast once both were lightened to clear the contrast floor, an unworkable collision for the two most important state signals in the interface. Valley blue restores separation. 8.53:1 on carbon, recomputed and matching the code comment.
- **Red-Pencil** (`#E8705C`, `--red`): a correction mark, and every destructive action: errors, the stop control, high-risk chips, denied decisions, delete. The one colour convention this product keeps across every rebuild. 5.84:1 on carbon, recomputed and matching the code comment.

### Tertiary

- **Graphite Steel** (`#8FB0C4`, `--teal`): the database/MCP hue, used in the sidebar's MCP row and in `McpView.vue`. 7.76:1 on carbon, recomputed and matching the figure in the code comment, though that same comment also calls the value "this blue-violet" in the sentence right after naming it "graphite steel", a leftover from the previous world's teal, which really was a blue-violet at a different hex. The comment was only partly rewritten; the current hex is unambiguously a cool blue-grey steel, not a violet.
- **Identity Violet** (`#A99BD0`, `--purple`): 7.01:1 on carbon. This is not, in practice, the sole identity colour. `src/renderer/project-accent.ts` hands out project and group identity from a six-token rotation, `[--blue, --amber, --purple, --green, --red, --teal]`, hashed from the project id. A project can therefore be identified by the same hue that means "attention owed" or "error" or "the action colour" elsewhere in the interface; identity and state share a palette because there is no seventh hue reserved for identity alone. This is worth stating plainly because a reader could otherwise assume `--purple` is identity's dedicated lane; it is one of six.

### Neutral

- **Carbon** (`#17181B`, `--bg`) and **Paper** (`#F6F4EF`, `html.sb-light --bg`): the ground itself in each theme. The light ground was a neutral `#F7F7F7` until it was warmed to sit in the same family as its own panels and cards; a neutral ground between warm panels and warm ink was the single largest reason the paper theme read as dirty rather than as paper.
- **Panel** (`#131417` dark / `#EFEDE6` light, `--bg-panel`): the sidebar and composer, a deliberate step darker (dark theme) than the ground it sits within so the seam between plate and panel reads.
- **Card** (`#1D1F23` dark / `#FCFBF7` light, `--bg-card`) and **Code Plate** (`#141518` dark / `#F1EFE8` light, `--bg-code`): the content-object tier and the terminal/code-text tier respectively.
- **Ink ramp** (dark theme, on carbon): Bright `#F4F4F2` (16.12:1), Strong `#E6E5E1` (14.08:1, also `--text`, the default body colour), Title `#D8D7D2` (12.32:1), Body `#B7B6B0` (8.73:1), Meta `#A3A29C` (6.94:1), Mid and Tab both `#9B9A94` (6.29:1, identical hex for two different-named roles in the dark theme only; the light theme gives them distinct values, `#55534D` and `#605E57`), Ghost `#97968F` (5.98:1). All figures independently recomputed against the current hex values.
- **`--text-on-wash`**: a role, not a ramp step. It exists because the standard ink ramp was measured against the flat ground, and the in-code comment argues that `--text-ghost` fails AA once it sits on a lightened wash surface (`--bg-hover` or `--bg-active`). Recomputing the wash composites against their actual backing surfaces (`--bg-hover` and `--bg-active` laid over the sidebar's own `--bg-panel`) gives figures noticeably higher than the specific numbers quoted in the comment (roughly 5.0 to 5.4:1 for Ghost, not the 3.85 to 4.32:1 the comment states), though still consistent with the *conclusion* that Ghost is the tightest tier and a dedicated, slightly lighter role tier is the safer choice. Treat the role and its existence as verified; treat the specific decimal figures printed in the comment as unconfirmed under the current token values, which is exactly the kind of stale in-code figure this document was asked to catch rather than repeat.
- **Mountain Gray** (`#B9B6AE`): the direction contract's fifth named material colour ("mountain gray as structure"). It has exactly one built expression, and now only in the dark theme: the hardcoded hex inside `--bg-active` (`color-mix(in srgb, #B9B6AE 12%, transparent)`), the wash behind a selected sidebar lane. It is not a named CSS custom property of its own and has no other consumer. On paper that mix landed *lighter* than the hover wash sitting above it in the same list, so the light theme now overrides `--bg-active` with a graphite mix instead and mountain gray no longer appears there.
- **Border** (`rgba(244,244,242,0.11)` dark / `rgba(10,10,10,0.13)` light) and **Border Strong** (`rgba(244,244,242,0.22)` dark / `rgba(10,10,10,0.26)` light): every rule scored into the sheet, from card edges to input strokes.

### The Proof Sheet (light theme)

`html.sb-light` is a genuine second theme, not a filter over the dark one. Text darkens to graphite and all three accents darken independently so each clears contrast on paper at its own value: foil green becomes `#1F6E44` (5.81:1, recomputed), valley blue becomes `#2C5F94` (6.18:1), red-pencil becomes `#A02A1B` (6.90:1), graphite steel becomes `#3F5A6B` (6.79:1), identity violet becomes `#5B4E77` (7.00:1). Ink and sheet are deliberately opposite temperatures, as they are on carbon: where the dark sheet sets warm ink on a cool ground, paper sets cool graphite (`--text` `#1A1C20`, palest tier `#5D6269` at 5.6:1) on a warm ground. The ramp was warm on both sides until it was cooled, which is what let ink and sheet read as one beige material.

Three light-only rules follow the same subtractive principle rather than inheriting the dark theme's additive one. `--bg-active` is a graphite mix (`#1A1C20` at 9%), because the carbon-tuned mountain-gray wash landed at 234 over a paper panel while `--bg-hover` lands at 229, making the selected lane the weaker of the two. `--green-glow` is an ink shadow rather than a green halo, because paper does not glow. `--scrim` is a 30% graphite veil rather than a pale one the same tone as the sheet it covers.

### Named Rules

**The Two-Track Wash Rule.** Every translucent wash and accent border derives from its solid token by construction, `color-mix(in srgb, var(--token) N%, transparent)`, never a hardcoded accent `rgba()` hue. Verified at 128 declarations across 14 files in `src/renderer`, and a scan of every `rgba()` triplet base in the renderer turned up only neutral bases (white, black, panel greys); no stray hardcoded accent triplet remains. Retuning a token therefore reaches every wash that derives from it automatically.

**The Contract Amendment Rule.** When a named material colour cannot clear the contrast floor without colliding with another state signal, the amendment is recorded in the token's own comment rather than silently changed. Valley blue's substitution for the contract's original ochre is the current example; the previous world recorded an equivalent amendment for its own ochre-vs-red collision. Legibility of state beats fidelity to an earlier colour choice, and the reasoning stays attached to the code.

**The Fine Gets No Hue Rule.** A finished lane draws a locked fold in neutral ink, not a "success" colour. Only three states carry colour (held, working, error); a finished or ended lane is deliberately colourless so it does not compete with a lane that still needs the developer.

## Typography

**Display Font:** none. There is no display tier in this interface.
**Body Font:** a system UI stack (`system-ui, -apple-system, 'Segoe UI', sans-serif`), used for everything except genuine code, commands, and terminal output.
**Label/Mono Font:** JetBrains Mono, loaded locally via `src/renderer/assets/fonts.css` for exactly this purpose.

**Character:** the interface has carried, and shed, two custom display faces across its rebuilds: Instrument Sans (a known training-data default, removed for the system's own UI font) and, before that, a Georgia serif reserved for a now-deleted vocabulary of score terms. `fonts.css` documents the Instrument Sans removal directly; the serif face is not merely removed, it never existed in this world at all: `--serif` is declared in `:root` but resolves to the identical system sans stack, not to any distinct serif face. There is, in the shipped code, no typographic gesture beyond "system sans for everything, JetBrains Mono for real text content."

### Hierarchy

Counted directly by grepping every `font-size:` declaration in `src/renderer` at the time of writing:

- **Meta** (400, 10.5px): the most-used size, 66 declarations. Secondary lines, timestamps, pills, footer readings.
- **Mono** (typically 600, 11.5px, JetBrains Mono): 57 declarations at this size; the button/pill/chip idiom and explicit `font-family: var(--mono)` content share this step.
- **Label** (400, 11px): 53 declarations. Only the sidebar's own `PROJECTS` section heading carries the intended 0.08em uppercase tracking (`.section-label`); a full scan of every `letter-spacing` declaration in the renderer found 12 distinct hardcoded values, from 0.02em to 0.18em, spread across 14 files. `Sidebar.vue` alone carries three of them (0.02em, 0.08em, 0.12em) on three different elements, so this is not even file-by-file consistent. This tier's tracking is observed drift, not a shared convention, and `--track-label` (see Typography Named Rules and Shapes) has not closed that gap.
- **Caption** (400, 10px): 50 declarations. Sub-labels, chip text, agent lines.
- **UI** (400, 12px): 45 declarations. Control and row labels.
- **Micro** (400, 9.5px): the floor of the ramp proper, 25 declarations. Nothing the reader must read in sequence sits here.
- **Body** (400, 13px, 1.6): 24 declarations, and the base size on `html`, so 13px is the default rather than a step down.
- **Body Compact** (400, 12.5px, 1.6): 19 declarations. Dense prose inside cards.
- **Title** (600 to 700, 13.5px, 0.02em on the brand lockup specifically): 6 declarations. Brand lockup and view/profile headers.
- **Headline** (600, 15.5px): 2 declarations, the ceiling of the ramp: the bridge-missing fallback lockup and the remove-project dialogue title.
- A small cluster of near-duplicate steps (14px x4, 15px x5, 12.8px x5, 11.8px x2) sits between these named tiers, mostly one-off header and profile sizes that never converged onto Title or Body Compact. Recorded as observed, not prescribed; nothing here should be read as a hidden tenth tier.

**Glyph sizing is not type sizing.** Icon and symbol glyphs are sized to optical weight, not to this ramp, and fall outside it by design. Four of these are the exact selectors an automated design-detector hook currently flags as font-size findings on every run of this codebase; the carve-out below is what should keep them from being treated as drift:

- `.group-caret` (8px, `Sidebar.vue`): the section-fold disclosure triangle.
- `.dfo-caret` (8px, `DiffView.vue`): the folder-fold disclosure triangle in the Diff
  tab's file list, added with that grouping. Deliberately the same 8px as
  `.group-caret` rather than a size of its own: they are the same gesture, and the
  app's two disclosure triangles reading at two sizes would be the drift, not the
  shared value.
- `.rd-icon` (17px, `Sidebar.vue`): the remove-project dialogue's warning glyph.
- `.empty-icon` (22px, `InboxView.vue`): the inbox-zero checkmark.
- `.ni-icon` (20px, `SpecsView.vue`): the Spec Kit not-installed glyph.

A fifth glyph of the same kind exists and is not yet in that carve-out: `McpView.vue`'s `.empty-ico` (26px). It has not appeared in the design-detector hook's findings cache for this codebase (`.impeccable/hook.cache.json` has no entry for `McpView.vue` at all), so it is either unscanned or simply has not been touched recently; either way, treat it as a sixth glyph waiting to be added to the exemption list rather than as a confirmed false positive today.

### Named Rules

**The Machine-Read Rule.** This replaces the Earned Monospace Rule, which confined JetBrains Mono to genuine code, commands, paths, terminal output, and the button/pill/chip idiom. The remit is now the whole machine-read stratum: those things, plus labels, counters, timers, ids, branches, statuses, model names, tab and segment labels, and the composer the operator types into. What stays in the system sans is prose: sentences addressed to the reader, rendered message bodies, empty-state copy, notes, hints, and warnings.

The `.mono` CSS *class* now resolves to `var(--mono)` and means what it says. It previously resolved to `var(--sans)` while roughly four hundred call sites applied it expecting monospace, which made it a trap rather than a utility; flipping the declaration gave those call sites what they had always asked for, and the dozen prose sentences that carried the class by habit had it removed instead. The one deliberate judgement inside the split: `.scan-banner` keeps mono because it is a terminal status line with a block caret, sentence or not.

**The Available But Unadopted Rule.** The direction contract states, in the present tense, "identifiers carry mono spec labels the way a crease carries M-128." The stylesheet declares a `.spec-label` utility and a `--track-label: 0.11em` token specifically to deliver that. Neither is applied anywhere: a repository-wide search (including the production build output in `out/`) found `.spec-label` defined once in `styles.css` and consumed by zero templates, across zero `.vue` files. No project id, session id, or branch renders through it. The label-tracking drift the utility was built to close (see Hierarchy, above) is therefore unchanged from before the utility existed, 12 distinct hand-set values still in play. This is a present-tense sentence in the contract that is false of the shipped app today, not a subtle gap: the fix was written and never wired in. The same pattern recurs for hairline angling in Shapes, below.

## Layout

One fixed desktop window, unchanged in structure across rebuilds: zero `@media` queries anywhere in the renderer. `src/renderer/App.vue`'s `.panes` carries `min-width: 1080px` and `min-height: 560px`, and `src/main/index.ts` sets the same `minWidth: 1080` on the `BrowserWindow` itself, with a code comment on each side pointing at the other so the pairing does not silently drift. The sidebar is 252px expanded, 64px collapsed by a user-clicked toggle rather than a breakpoint; the centre pane hosts the session stream and its bottom-pinned composer; the inbox pane is drag-resizable between 280px and 680px and can be collapsed to a 44px rail with a pulsing reopen badge.

The direction contract calls this arrangement "the peg rail": the centre is reserved for the work in hand, and the sidebar and inbox hang off the two edges. That framing is realised as three flex panes, not as anything more literal.

Rhythm: rows carry 8px by 13 to 18px padding, the sidebar's own floating lanes excepted at 6px by 10 to 12px inside an 8px inset; the recurring spacing steps measured across the renderer are 2, 4, 6, 8, 10, 13, 14, 18, 22 and 24px. A sixty-degree crease lattice (two repeating diagonal gradients at faint alpha) is painted on `body` and again, independently, on `App.vue`'s `.main` pane, because the three panes fully cover `body` and `.main` is the largest field the developer actually looks at; the light theme's crease is subtractive where the dark theme's is additive, and is set *below* it in alpha (`rgba(10,10,10,0.026)` on `body` and `0.028` on `.main`, against the dark theme's `rgba(244,244,242,0.028)` / `0.03`) because a dark hairline on a bright field carries about twice the step. At the `0.045` / `0.05` it used to carry, the lattice stopped being the ground and became the pattern, most obviously on the empty part of the centre pane.

List headings stick and stack: the sidebar's `PROJECTS` bar pins at the scroll container's top, and each project-group heading pins beneath it at an offset now computed from `--section-row-h` (the add-button height plus its own padding) rather than a hardcoded pixel value repeated in two places, which is how it used to be and used to drift.

## Elevation & Depth

No glass. `backdrop-filter: blur()` appears exactly once in the entire renderer, on the modal overlay scrim (`.overlay`), and nowhere on a pane or a sticky heading. Depth reads as a stack of opaque, layered plates:

1. **The ground.** `body` and `.main` carry the crease lattice described in Layout, resolving to the theme's flat ground colour underneath.
2. **Panels** (`--bg-panel`). The sidebar and composer.
3. **Sticky headings** (`--bg-sticky`), denser again than the panel they float within.
4. **Cards** (`--bg-card` / `--bg-card-alt`). Content objects within a panel.
5. **Overlays.** A scrim (`--scrim`, themed per mode) with a 4px blur covers everything; the dialogue above it is the only tier permitted a real cast shadow (`--shadow-dlg`).

`--elev` is a 1px inset highlight plus a 1px drop shadow, a lip of light on an edge rather than a floating card. `--gloss` is a deliberate no-op transparent-to-transparent gradient in the dark theme and becomes a genuine faint white sheen (`rgba(255,255,255,.1)` fading to nothing) on the light theme, because the code's own comment frames paper as catching light where carbon does not.

### Named Rules

**The Earned Shadow Rule.** Only the overlay/dialogue tier casts a real shadow (`--shadow-dlg`, `--shadow-dd`, `--shadow-menu` for dropdowns and menus). A card that wants to lift off its panel is asking for the wrong tier.

**Amendment, by direction rather than by drift.** One surface below the dialogue tier now casts: the sidebar lane. The owner asked for the project list to be separated and "maybe even floating", picked the floating variant in live mode over two alternatives that spent no vertical room, and that brief outranks this rule; PRODUCT.md's Brand Commitments already record that no visual register here is binding. The exception is deliberately narrow, and is one token, `--lane-cast` on `.project-list`, so it cannot spread by copy-paste without being named. It also does not work the way the dialogue tier does: `--elev` leads the value, because a dark cast on carbon is almost invisible and the lanes were measured separating on fill alone, so the lip of light is additive on carbon exactly where the cast is subtractive on paper. Any further surface that wants to cast still needs a direction, not a precedent.

## Shapes

`--rc` and `--rp` are both `0px` in the current build. The in-code comment for `--rc` states this directly: "a fold is a cut, not a curve, so corners stay sharp at 0," a deliberate departure from a previous world where the equivalent token was 10px, then 3px. `--rp`, the token reserved for anything that reports a value (badges, pills, switches), was `99px` (fully round) in the previous world and is also `0px` now: the code's own comment reframes this as "a tag that reports a figure is scored square like everything else," a genuine change in doctrine, not merely a retuned number. A repository scan found zero remaining hardcoded `border-radius: 99px` declarations; the token change reached every site. `--rc` is referenced 92 times across 17 files and `--rp` 36 times across 13 files.

Three kinds of exception survive, and they do not all point the same direction:

1. **Small interactive glyph patches stay slightly soft.** The add-project hover target and the drag-and-drop highlight use a hardcoded 6px; small colour swatches (the group-colour dot, a 6px square) use a hardcoded 2px, softening a tiny square without rounding it into a dot; the selected-lane highlight and the settings-row hover use a hardcoded 8px, a step looser than content because a row is a target rather than a container.
2. **A handful of small round point-markers are exempt from the flat rule entirely, and there are three of them, not one.** `.gs-ring` in `GlobalSpinner.vue` stays a true circle (`border-radius: 50%`) because it rotates, and a rotating square reads as a glitch. `.mcp-dot` in `Sidebar.vue` forces `border-radius: 50% !important` specifically to read as a connection-status dot rather than the square status marks used elsewhere. `.foot-dot` in `Sidebar.vue`'s footer counters (`50%`, unmarked with `!important` because nothing else touches it) is the same idea for the running/needs-you tally. All three are small, round, and report a live status or a rotating process; none of them contain text or identity.
3. **Two stray 3px radii are an unmigrated leftover, not a deliberate exception.** `SettingsPanel.vue`'s `.mcp-check` carries a comment calling 3px "the documented content radius," and `EvalsView.vue`'s callout uses the same value without comment. Both predate the move to `--rc: 0px` and were not swept up when the token changed; there is no current documentation anywhere else that calls 3px the content radius, because the content radius is 0px. Treat these two as drift to fix, not as a third named exception.

Identity markers stay sharp on principle even where a "dot" name suggests otherwise: `SessionView.vue`'s `.h-dot`, which carries a project's identity colour exactly like the sidebar's fold tick, has no `border-radius` declared at all and renders as a plain square, consistent with identity staying cut rather than rounded. It sits alongside two genuinely round dots (`.mcp-dot`, `.foot-dot`) that are state or tally markers, not identity, which is a coherent split even though all three share the word "dot" in their naming.

**Two more direction-contract commitments are available but unadopted, and one is simply absent**, beyond the unwired `.spec-label` covered under Typography:

- **"Hairlines terminate at an angle."** This is stated in the present tense in the direction contract, and it is false of the shipped app today. A `.scored-rule` utility exists in `styles.css` and is a real, working implementation: a `skewX(-30deg)` cut on the last 14px of a border's trailing edge, via a `::after` pseudo-element. It is applied nowhere. A repository-wide search, including the production build output, found it consumed by zero elements across zero templates. Every hairline actually shipped in the interface terminates square: the tab underline, the composer's top border, the inbox divider, all of them.
- **Chamfered corners exist, but only in one place, and not through the shared utility built for it.** A `.chamfer` utility (a 7px corner cut via `clip-path`) is likewise defined and never applied. The chamfer concept itself does ship, but only inline: `styles.css`'s shared `.dialog` rule carries its own separate 10px `clip-path` polygon, consumed by three dialogues (`ProjectRegistration.vue`, `SettingsPanel.vue`, `Sidebar.vue`'s remove-project dialogue). The utility class and the shipped chamfer are two different, disconnected pieces of CSS that happen to express the same idea at two different radii.
- **The parallelogram shear and corner tabs from the source world's component board are simply absent, not merely unadopted.** Unlike `.spec-label` and `.scored-rule`, there is no utility, token, or partial implementation for either anywhere in `src/renderer`: no `skew()` transform outside `.scored-rule` itself and no tab-shaped clip-path exists in the codebase. If a future pass wants either, it is starting from nothing, not wiring up something already built.

Chamfering, where it is used, is deliberately withheld from anything focusable: the styles.css comment is explicit that `clip-path` would clip a focus outline along with the corner, so only non-focusable surface containers (the dialogue shell itself) get the cut.

Borders are uniformly 1px, drawn in translucent ink. A dashed border is reserved for the drag-and-drop drop-target affordance, in the action colour.

## Components

**Character: instrument first, chrome second.** Controls stay close to invisible until the pointer reaches them; a project row's remove control and similar bare-glyph controls carry no chrome at rest. Colour is spent on state and the action colour; everything else is grey ink on the sheet.

### Buttons

- **Shape:** `--rc` (0px) on every variant; nothing here is rounded.
- **Primary** (`.btn-solid`, `.send-btn`): a 135-degree foil-green gradient (`var(--green)` to `var(--green2)`) under a shallow top-left raking highlight and the shared `--gloss` layer, 11.5px JetBrains Mono at weight 600, 6px by 14px padding, a foil-coloured glow shadow (`--green-glow`).
- **Hover:** the gradient flattens to `--green-hover`, a brighter flat foil green.
- **Armed** (`.btn-armed`): the same geometry filled valley blue, for the second step of a destructive confirmation, entering with a 0.2s rise-and-fade (`sbIn`) so the state change is visible.
- **Outline** (`.btn-outline`): transparent with a strong hairline border and tab-tier text; hovering turns the border and text red-pencil, making outline the cancel-and-destroy idiom rather than a neutral secondary.
- **Quiet** (`.btn-quiet`): identical geometry, hovering to a foil-green border and brighter text, the true neutral secondary.

### Chips

- **Risk chips** (`.chip-risk`): 10px mono, sharp corners, 1px by 6px padding. Low is a bare hairline border; medium adds valley-blue text and border; high adds a faint red-pencil wash behind a red-pencil border, three readable escalation steps.
- **Marker chips** (`.chip-marker`): the decision record in the stream; approved is foil green on a 7% wash, denied is red-pencil, pending is valley blue, expired falls back to a bare border.
- **Count badge** (`.badge-count`): valley-blue text on a 13% valley-blue wash with a 35% border, sharp corners now rather than the pill shape a "badge" name might suggest, `white-space: nowrap`.

### Cards / Containers

- **Corner Style:** 0px (`--rc`) at rest; the shared `.dialog` rule adds its own separate 10px chamfer via `clip-path` (see Shapes).
- **Background:** Card tier, `var(--gloss), var(--bg-card-alt)`, so the light theme's sheen appears without the ground colour changing.
- **Shadow Strategy:** hairline lip only (`--elev`); see Elevation & Depth.
- **Border:** 1px translucent ink, stepping to Border Strong on hover.
- **Internal Padding:** 16px for the shared dialogue base; the one dialogue carrying a warning (remove-project) overrides to 24px; list-row cards sit around 8px by 10px to 18px.

### Inputs / Fields

- **Style:** code-plate background (`--bg-code`), Border Strong, sharp corners, 6px by 10px padding, the 13px sans body face.
- **Focus:** a 1px foil-green outline, the only focus treatment in the system, applied globally to inputs, textareas and selects, including the composer's own multi-line field (a prior `outline: none` override on the composer input was deliberately deleted so it would pick up this same ring).
- **Filter field:** a variant with no fill, whose border turns foil green both on focus and whenever a query is active.
- **Inline rename:** panel background with a full foil-green border, marking the field as a live edit of the row it replaces.

### Navigation: the sidebar

The sidebar's project list is the application's real navigation, and it is where this world's signature marks live.

- **The lane bar** (`.brace` in the markup, a name left over from the fold tick it replaced): part identity as a 2px CSS bar in the project's rotated accent colour, run the full height of the row. The SVG fold tick it replaced is deleted; a hairline that must match the row's height exactly is a worse job for artwork than for a border.
- **The floating lane** (`.project`): a lane is a sheet inset 8px from both panel edges, filled at the card tier, carrying `--lane-cast` and lifting further when selected. Square still, at `--rc`. The hairline that used to be ruled at each row edge (`.project::before` / `::after`) is deleted: with a 2px gap, adjacent lanes showed both their rules 2px apart, and that doubling read as a crowded list rather than as the table of lanes it was defending. Nothing replaces it, because a floating sheet does not need an edge drawn on it as well. On the 64px collapsed rail the inset drops to 4px and the padding to 4px, or a card would have 23px of content for a pair of initials and a pending count.
- **The status bar** (`components/StatusBar.vue`): one 25px rule under every pane carrying the board's readings, running and waiting counts, spend today, tokens today, and the limit meter, plus the real key bindings on the right. These were a stacked card in the sidebar footer; a control room keeps its gauges along the bottom edge. The footer that remains carries Settings and the work model, nothing else.
- **The binding badge** (`.ctl-key`, `styles.css`): a control that has a keyboard shortcut prints it on its own face in the mono badge idiom, inheriting the control's colour so it follows hover. Only bindings that exist get one, and the status bar's `⌃C interrupt` hint appears only while a session is mid-turn, because that is the only time the binding does anything.
- **The run stamp** (`.head-stamp`): the session's id quoted to eight characters at the ghost tier, the way a commit hash is quoted, with the full id on the title. It is what you need to name one specific run or match the pane against a log.
- **The block caret**: the composer sets `caret-shape: block` with `caret-color: var(--green)`, so the cursor in the field you type into is a terminal's cursor rather than a text bar. Chromium 139 and up honour it; older engines keep the bar caret, which is a fallback rather than a fault.
- **Lane height**: the lane was cut to about 43px selected and 28px plain, down from 50px and 36px, because the sidebar is the surface that runs out of room first and this is a tool for holding more than six projects at once. Floating gave some of that back, and the figure is exact rather than estimated: 2px more padding and a 4px wider gap grow each lane's pitch by 6px, about one lane in every six. The trade was made knowingly, and the budget it spends from still stands.
- **The status mark** (`.mark`): one JetBrains Mono character in the state colour with nothing behind it, paired with a plain-language word via `markTitle()` so the glyph only narrows a guess the word already settles. The five geometric folds it replaced, and the tinted plate they sat on, are both gone by request.
  - **Held** (needs you), valley blue: one crease scored but not yet folded either way.
  - **Deploying** (working), foil green: three facets opening out of the packet.
  - **Misfold** (error), red-pencil: two creases crossing where they cannot both hold.
  - **Packed flat** (session ended), ghost-tier ink: the sheet folded back to a packet.
  - **Locked** (done), no hue at all: the fold seated.
- **No mark carries its own motion.** The previous world's shared "now-line," one authored animated rule that crossed every lane, is deleted outright with nothing replacing it: a sheet at rest does not pulse, and the mark plus its paired word already say "working" without help from movement. The `sbFade`, `sbPulse`, `sbBlink` and `inboxPeekGlow` keyframes still exist and still animate small unrelated indicators elsewhere (parallel-agent squares, the inbox group dot, the terminal caret, the collapsed-inbox reopen badge), but none of them are this signature component's own idiom.
- **Lanes are keyboard-operable:** `tabindex`, Enter and Space all select a project, with an inset focus ring (`box-shadow: inset 0 0 0 1px var(--green)`) that never shifts the lane's geometry.

## Do's and Don'ts

### Do:

- **Do** call the attention-owed colour Valley Blue, and the error colour Red-Pencil. Do not use "ochre" or "red" loosely for either; the direction contract's original ochre could not survive contact with the error colour on this ground, and that amendment is recorded in the code, not just in this document.
- **Do** treat `--rc` and `--rp` as `0px` for everything except the three named round point-markers (`.gs-ring`, `.mcp-dot`, `.foot-dot`). The small interactive-patch exceptions once catalogued in Shapes (6px on the glyph buttons and the group drop target, 2px on the group swatch, 8px on the active-row wash, the settings row, the remove button and the confirm/cancel pair) are gone: all eight now take `var(--rc)`, so the only curve left in the interface is a point-marker that is meant to read as a dot.
- **Do** derive every wash from its solid token with `color-mix(in srgb, var(--token) N%, transparent)`. Never hardcode an accent `rgba()` triplet; a repository scan confirms none currently exist.
- **Do** set anything the machine reports in JetBrains Mono: terminal output, commands, paths, the button/pill/chip/badge idiom, and now labels, figures, timers, ids, branches and statuses too. Sentences addressed to the reader stay in the system sans stack; there is no serif face anywhere in this world.
- **Do** leave figures on tabular numerals. `html, #app` sets `font-variant-numeric: tabular-nums` for the whole interface, so a ticking timer or cost holds its column instead of shuffling the text beside it. Do not override it locally.
- **Do** add explicit dark and light values for any new token, and check the direction as well as the value: on carbon a wash, a glow and a veil all add light, and on paper all three subtract it. `--bg-active`, `--green-glow` and `--scrim` each needed a light override for exactly that reason, and each is a one-line answer to "what does this mark do to paper?"
- **Do** pair any new status mark with a plain-language title or label, the way `markTitle()` does for the sidebar's fold marks, so a shape never has to be learned before it can be understood.

### Don't:

- **Don't** grow the lane bar past 2px, and don't move it to the row's outer edge. The old rule here banned anything thicker than a 1px stroke; that was overruled on request, because 1px could not hold a lane once the row was ruled at both edges. What the old rule was protecting against still stands: the bar is a mark inside the row, not a filled band on its boundary, and it never gains a background, a gradient or a second colour.
- **Don't** reintroduce `backdrop-filter` blur on a panel or a sticky heading. It appears exactly once in the renderer, on the modal scrim, and should stay that isolated.
- **Don't** add a media query or a percentage-based breakpoint. The target is one fixed desktop window (`min-width: 1080px` on `.panes`, matched in `BrowserWindow`), and the sidebar collapse is a user toggle, not responsive behaviour.
- **Don't** assume `.spec-label`, `.scored-rule`, or the `.chamfer` utility are live just because they are declared in `styles.css`. None of the three is applied anywhere in the current templates or build output; treat each as available but unadopted (see Typography and Shapes) rather than as an established pattern to extend. The parallelogram shear and corner tabs from the source world's component board are a step further still: not merely unadopted, but absent from the codebase entirely.
- **Don't** copy the specific decimal contrast figures printed in the `--text-on-wash` code comments without re-checking them. Independent recomputation against the current token values gives noticeably different (though still passing) numbers; the role itself is sound, the printed figures in that one comment are not confirmed.
- **Don't** give a new "empty state" glyph the class name `.empty-title` without checking `McpView.vue` (14.5px, weight 600) and `InboxView.vue` (13px, weight 400) first. Both currently use that exact class name for visually different treatments; this is live, unresolved type drift, not a documented variant.
