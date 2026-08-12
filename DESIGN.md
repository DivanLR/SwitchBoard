---
name: Switchboard
description: A Miura-fold sheet, scored and folded flat, deployed by one pull.
colors:
  sheet-carbon: "#17181B"
  sheet-cornflower: "#F4F6F9"
  panel-carbon: "#131417"
  panel-cornflower: "#EAEDF2"
  card-carbon: "#1D1F23"
  card-cornflower: "#FFFFFF"
  code-plate-carbon: "#141518"
  code-plate-cornflower: "#EEF1F5"
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

The material is the same physical object in two lights, not two designs. In carbon fibre (`#17181B`), the ground reads as dense composite under a faint sixty-degree crease lattice; in light mode the lattice is GONE, along with warm paper itself (amendment 2026-08-12; the light theme is now Cornflower, a flat cool-grey canvas with no lattice at all, and the sentence that stood here described the withdrawn Proof Sheet). Three semantic accents carry meaning and meaning alone: foil green is the one action colour, for every action that deploys or advances a lane; valley blue is attention owed, meaning a lane is held and awaiting a decision; the red-pencil mark is a correction, meaning error. A finished lane earns no hue at all, drawing a locked fold instead of a coloured badge. Project identity is a separate concern from state and is carried by a third mechanism entirely, a one-pixel fold tick coloured from a six-way rotation that happens to reuse the same accent tokens (see Colors, Named Rules).

This build's own finish clause, written into the direction contract, states that "unreviewed and undocumented is unfinished." This document is that review. Where the contract's own language promised something the shipped code does not yet do, that gap is recorded here as open rather than smoothed over, most visibly in Typography's Named Rules and in Shapes.

**Key Characteristics:**

- Two token sets, TWO worlds since 2026-08-12: `:root` is the carbon sheet and `html.sb-light` is Cornflower, a separate light design taken from a named external reference. They share the token NAMES, and therefore all 17 files that consume them, but no longer share an accent hue or a corner radius. See Colors, Cornflower (light theme).
- Three accents carry state (foil green for action/working, valley blue for attention owed, red-pencil for error); a finished lane carries none.
- Corners are cut, not rounded ON CARBON: `--rc` and `--rp` are both `0px` in `:root`, with three named, deliberate circle exceptions. In light mode they are `6px` and `4px`; see Shapes.
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

- **Carbon** (`#17181B`, `--bg`) and **Cornflower canvas** (`#F4F6F9`, `html.sb-light --bg`): the ground itself in each theme. The light ground was neutral `#F7F7F7`, then warm paper `#F6F4EF`, and is now a cool grey-blue taken from the Cornflower reference. Each move is recorded because each was a change of doctrine, not a retuned number.
- **Panel** (`#131417` dark / `#EFEDE6` light, `--bg-panel`): the sidebar and composer, a deliberate step darker (dark theme) than the ground it sits within so the seam between plate and panel reads.
- **Card** (`#1D1F23` dark / `#FCFBF7` light, `--bg-card`) and **Code Plate** (`#141518` dark / `#F1EFE8` light, `--bg-code`): the content-object tier and the terminal/code-text tier respectively.
- **Ink ramp** (dark theme, on carbon): Bright `#F4F4F2` (16.12:1), Strong `#E6E5E1` (14.08:1, also `--text`, the default body colour), Title `#D8D7D2` (12.32:1), Body `#B7B6B0` (8.73:1), Meta `#A3A29C` (6.94:1), Mid and Tab both `#9B9A94` (6.29:1, identical hex for two different-named roles in the dark theme only; the light theme gives them distinct values, `#55534D` and `#605E57`), Ghost `#97968F` (5.98:1). All figures independently recomputed against the current hex values.
- **`--text-on-wash`**: a role, not a ramp step. It exists because the standard ink ramp was measured against the flat ground, and the in-code comment argues that `--text-ghost` fails AA once it sits on a lightened wash surface (`--bg-hover` or `--bg-active`). Recomputing the wash composites against their actual backing surfaces (`--bg-hover` and `--bg-active` laid over the sidebar's own `--bg-panel`) gives figures noticeably higher than the specific numbers quoted in the comment (roughly 5.0 to 5.4:1 for Ghost, not the 3.85 to 4.32:1 the comment states), though still consistent with the *conclusion* that Ghost is the tightest tier and a dedicated, slightly lighter role tier is the safer choice. Treat the role and its existence as verified; treat the specific decimal figures printed in the comment as unconfirmed under the current token values, which is exactly the kind of stale in-code figure this document was asked to catch rather than repeat.
- **Mountain Gray** (`#B9B6AE`): the direction contract's fifth named material colour ("mountain gray as structure"). It has exactly one built expression, and now only in the dark theme: the hardcoded hex inside `--bg-active` (`color-mix(in srgb, #B9B6AE 12%, transparent)`), the wash behind a selected sidebar lane. It is not a named CSS custom property of its own and has no other consumer. On paper that mix landed *lighter* than the hover wash sitting above it in the same list, so the light theme now overrides `--bg-active` with a graphite mix instead and mountain gray no longer appears there.
- **Border** (`rgba(244,244,242,0.11)` dark / `rgba(15,19,26,0.16)` light) and **Border Strong** (`rgba(244,244,242,0.22)` dark / `rgba(15,19,26,0.60)` light): every rule scored into the sheet. In light the two are no longer one family at two weights: Border Strong bounds a control and clears 3:1, Border separates two surfaces and deliberately does not. See Cornflower (light theme).

### Cornflower (light theme)

**AMENDMENT, 2026-08-12. The light theme is no longer the same sheet on paper.** It was replaced on the owner's direction against a named external reference, the Cornflower design system, described by its own registry as "white cards floating on a cool light-gray canvas, a single restrained cornflower-blue accent, soft low-alpha shadows, nothing shouts". The previous light theme, The Proof Sheet, is gone: warm paper `#F6F4EF`, the cool-graphite ink ramp, and the scored crease lattice on the light ground are all withdrawn, not retuned. **The dark theme is untouched and remains this world's home ground.** Everything else in this document describes the dark sheet and still holds.

Read this section as the light theme's whole specification. Where an earlier statement elsewhere in this document describes paper, that statement now describes history.

**The ground.** Canvas `#F4F6F9`, panel `#EAEDF2`, sticky `#E2E6EC`, card pure `#FFFFFF`, code plate `#EEF1F5`. Seven opaque tiers, each one step of 1.03 to 1.05:1 from its neighbour. Ink and ground now agree in temperature, which is the exact opposite of the dark sheet's warm-ink-on-cool-carbon rule and is deliberate: the temperature opposition is what made the old light theme read as a printed material, and the material is what was asked to go.

**The accents diverge from dark for the first time.** The action colour is cornflower blue `#2B58CC` here and foil green on carbon; the two themes no longer share an accent, so the product now reads as one identity through structure, type and geometry rather than through hue. Attention owed moves off blue to `#8F5600`, because the action colour took blue. That is not a bright gold and cannot be: no saturated warm hue clears 4.5:1 on a near-white ground in sRGB, so amber here means the darkest legible amber. Error is `#A0141B`, pushed darker than a straight transposition so it separates from amber by luminance (1.34:1) as well as by hue.

**`--running` is a new token, and the reason it exists is the divergence above.** A lane reporting "working" must not report it in the action colour when the action colour is blue. `--running` is `#4DC97E` on carbon, which is exactly the action green it replaces there and therefore changes nothing in dark, and `#136F45` on Cornflower, derived from the reference's own success hue. The lane bar and the status chevron both read it, so the two marks cannot disagree.

**The contrast policy, and the one real judgement in it.** Every token carrying text clears 4.5:1 against the darkest ground it can land on, not the most flattering. Borders split into two classes on the letter of WCAG 1.4.11, which reaches a control's own boundary but does not reach a divider that is not the sole means of identifying a component:

- **Boundary tiers**, at or above 3:1: `--border-strong` (4.73:1), `--border-card` (3.11:1), `--border-seg` (3.08:1). These bound inputs, outline and quiet buttons, chips, segmented controls, dropdowns, menus, and clickable rows.
- **Separation tiers**, held at the reference's own soft weight of 1.2 to 1.4:1: `--border`, `--border-code`, `--border-card-alt`, `--border-soft`, `--border-hist`. These rule one surface off another, and the two surfaces already differ in tone, so the hairline is a second cue and not the only one.

Forcing 3:1 onto every hairline was tried and rejected: it draws every card edge as a mid-grey line and turns a calm interface into a wireframe. That trade is the one point on which the three independently-built candidate palettes disagreed, and it is settled here on the rule's actual scope rather than on taste.

**Light-only rules that do not simply invert the dark ones.** Washes subtract light, as they did on paper. `--green-glow` is tinted with the action colour itself, following the reference's one exception for its primary shadow, rather than being an ink shadow. `--hairline-shine` gains a light value for the first time: it was theme-neutral, so a 6%-white inset was inherited onto a near-white surface and vanished at all eight of its call sites. `.uc-bar`, the usage meter's track, gains a light override for the same reason. `.btn-solid` drops its 18% raking highlight in light, because on a flat blue fill it reads as a glossy gradient button, which the reference rules out in as many words.

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
- `.mode-dd-arrow` (8px, `SessionView.vue`): the session-mode picker's open/closed
  triangle on the ended-session banner. A third instance of the same gesture, taking
  the same 8px for the same reason — the shared value IS the convention here, so a
  new disclosure triangle picking its own size would be the drift. Listed rather
  than left to be re-flagged as a font-size finding on every run.
- `.rd-icon` (17px, `Sidebar.vue`): the remove-project dialogue's warning glyph.
- `.empty-icon` (22px, `InboxView.vue`): the inbox-zero checkmark.
- `.ni-icon` (20px, `SpecsView.vue`): the Spec Kit not-installed glyph.

A fifth glyph of the same kind exists and is not yet in that carve-out: `McpView.vue`'s `.empty-ico` (26px). It has not appeared in the design-detector hook's findings cache for this codebase (`.impeccable/hook.cache.json` has no entry for `McpView.vue` at all), so it is either unscanned or simply has not been touched recently; either way, treat it as a sixth glyph waiting to be added to the exemption list rather than as a confirmed false positive today.

### Named Rules

**The Earned Monospace Rule, restored by direction.** For one release this slot held the opposite rule, the Machine-Read Rule, which extended JetBrains Mono from genuine code out across the whole "machine-read stratum": labels, counters, timers, ids, branches, statuses, model names, tab and segment labels, buttons, pills, chips and project names. With `.mono` on 406 call sites that set essentially the entire interface in a code face. The owner's verdict on the shipped result was that the text reads bulky, oversized and ugly, and directed a return to a proportional UI face.

The verdict is a measurement rather than a preference, which is why it is recorded as a correction and not as a change of taste. A monospaced face fits a capital W and a lowercase i into one advance width, so at an identical pixel size it runs about a tenth wider per character and carries a taller x-height and heavier stems than a proportional UI face. No font-size grew when the Machine-Read Rule landed; every label simply got wider and heavier at once, which is exactly what "bigger" describes from the reading side.

The remit is therefore back to text where the character grid carries meaning: code, commands, filesystem paths, ids and hashes, diffs, terminal output, and the composer, because what gets typed into it is slash commands and `@paths`. Everything else — labels, names, statuses, buttons, pills, chips, tabs — is interface chrome, and chrome is set in the UI face.

Two classes, and the split is the whole rule:

- `.mono` resolves to `var(--sans)`. The name is now a misnomer and is kept anyway: the class is applied at precisely the places that meant "not body prose", which is the same set under either rule, and renaming it would touch 406 call sites to change nothing that renders.
- `.code` resolves to `var(--mono)` and is applied deliberately: the header's project path and session id, the sidebar's branch and path lines, the subsession branch, the composer. A surface that takes it because it feels technical does not take it.

The shared idiom classes moved with the rule: `.btn-solid`, `.btn-armed`, `.btn-outline`, `.btn-quiet`, `.link-green`, `.pill`, `.chip-risk` and `.badge-count` no longer declare `var(--mono)`. Monospace on a button was the costume, not the content.

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

**Amendment withdrawn: the sidebar lane no longer casts.** One surface below the dialogue tier used to, by direction rather than by precedent: the project lane was inset 8px from both panel edges, filled at the card tier and floated on a `--lane-cast` token, with a deeper cast again when selected. The owner asked for that, picked the floating variant in live mode over two alternatives, and has now withdrawn it: the list stopped reading as clean and minimal.

The mechanism is legible in hindsight and is recorded so the next pass does not rediscover it. A sidebar holding eight projects drew eight filled rectangles, eight drop shadows and eight full-brightness identity bars, all at rest, none of them responding to anything. Every lane was emphasised equally, so no lane could take emphasis when it had news — which is the one job this pane has. The float also cost 6px of pitch per lane, roughly one project in six off a screen that is this tool's actual budget.

A lane is a row again: full-bleed, transparent at rest, filled only on hover and on selection. The `--lane-cast` token is gone with it, so the Earned Shadow Rule is whole and only the overlay tier casts.

The identity bar changed with it, and the two only work together. It is 1px rather than 2px, and it sits at 0.45 opacity on every lane except the one you are in. `project-accent.ts` hashes identity out of the same six hues that mean working, attention owed and error elsewhere, so eight bars at full strength put eight state-coloured marks on screen that carried no state — noise wearing the vocabulary of the signal. Dimmed, they read as a way of telling one row from another, and the one at full strength is the row you are in. Selection is carried by three marks that agree and none of them is a shadow: the `--bg-active` wash, the identity hairline at full strength, and the brighter name.

## Shapes

`--rc` and `--rp` are both `0px` ON CARBON. **In light mode they are `6px` and `4px` (amendment 2026-08-12, on the owner's direction).** This is the one place the two themes differ in geometry rather than in colour, and it carries most of the modern read the Cornflower reference was chosen for. `--rp` is tighter than `--rc` on purpose: it is the idiom for a tag that reports a figure, and at 6px on an 18px chip the curve eats the digits and the tag stops being distinguishable from a button. The rest of this section describes the carbon values. The in-code comment for `--rc` states this directly: "a fold is a cut, not a curve, so corners stay sharp at 0," a deliberate departure from a previous world where the equivalent token was 10px, then 3px. `--rp`, the token reserved for anything that reports a value (badges, pills, switches), was `99px` (fully round) in the previous world and is also `0px` now: the code's own comment reframes this as "a tag that reports a figure is scored square like everything else," a genuine change in doctrine, not merely a retuned number. A repository scan found zero remaining hardcoded `border-radius: 99px` declarations; the token change reached every site. `--rc` is referenced 92 times across 17 files and `--rp` 36 times across 13 files.

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
- **Do** treat `--rc` and `--rp` as `0px` ON CARBON ONLY (light mode is 6px and 4px; see Shapes), for everything except the three named round point-markers (`.gs-ring`, `.mcp-dot`, `.foot-dot`). The small interactive-patch exceptions once catalogued in Shapes (6px on the glyph buttons and the group drop target, 2px on the group swatch, 8px on the active-row wash, the settings row, the remove button and the confirm/cancel pair) are gone: all eight now take `var(--rc)`, so the only curve left in the interface is a point-marker that is meant to read as a dot.
- **Do** derive every wash from its solid token with `color-mix(in srgb, var(--token) N%, transparent)`. Never hardcode an accent `rgba()` triplet; a repository scan confirms none currently exist.
- **Do** set anything the machine reports in JetBrains Mono: terminal output, commands, paths, the button/pill/chip/badge idiom, and now labels, figures, timers, ids, branches and statuses too. Sentences addressed to the reader stay in the system sans stack; there is no serif face anywhere in this world.
- **Do** leave figures on tabular numerals. `html, #app` sets `font-variant-numeric: tabular-nums` for the whole interface, so a ticking timer or cost holds its column instead of shuffling the text beside it. Do not override it locally.
- **Do** add explicit dark and light values for any new token, and check the direction as well as the value: on carbon a wash, a glow and a veil all add light, and on the light canvas all three subtract it. Check the ROLE too, now the two themes disagree on hue: a token meaning 'action' is green on carbon and blue on Cornflower, so anything meaning 'running' must read `--running` rather than `--green`, or it changes meaning with the theme. `--hairline-shine` is the cautionary case: it had no light value at all, so a 6%-white inset was inherited onto a near-white surface and vanished at eight call sites. `--bg-active`, `--green-glow` and `--scrim` each needed a light override for exactly that reason, and each is a one-line answer to "what does this mark do to paper?"
- **Do** pair any new status mark with a plain-language title or label, the way `markTitle()` does for the sidebar's fold marks, so a shape never has to be learned before it can be understood.

### Don't:

- **Don't** grow the lane bar past 2px, and don't move it to the row's outer edge. The old rule here banned anything thicker than a 1px stroke; that was overruled on request, because 1px could not hold a lane once the row was ruled at both edges. What the old rule was protecting against still stands: the bar is a mark inside the row, not a filled band on its boundary, and it never gains a background, a gradient or a second colour.
- **Don't** reintroduce `backdrop-filter` blur on a panel or a sticky heading. It appears exactly once in the renderer, on the modal scrim, and should stay that isolated.
- **Don't** add a media query or a percentage-based breakpoint. The target is one fixed desktop window (`min-width: 1080px` on `.panes`, matched in `BrowserWindow`), and the sidebar collapse is a user toggle, not responsive behaviour.
- **Don't** assume `.spec-label`, `.scored-rule`, or the `.chamfer` utility are live just because they are declared in `styles.css`. None of the three is applied anywhere in the current templates or build output; treat each as available but unadopted (see Typography and Shapes) rather than as an established pattern to extend. The parallelogram shear and corner tabs from the source world's component board are a step further still: not merely unadopted, but absent from the codebase entirely.
- **Don't** copy the specific decimal contrast figures printed in the `--text-on-wash` code comments without re-checking them. Independent recomputation against the current token values gives noticeably different (though still passing) numbers; the role itself is sound, the printed figures in that one comment are not confirmed.
- **Don't** give a new "empty state" glyph the class name `.empty-title` without checking `McpView.vue` (14.5px, weight 600) and `InboxView.vue` (13px, weight 400) first. Both currently use that exact class name for visually different treatments; this is live, unresolved type drift, not a documented variant.
