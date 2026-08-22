# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

The interface is a Vue 3 renderer inside an Electron shell on Windows. It is web
technology in a desktop wrapper, so it follows web design language rather than a
native iOS or Android one.

## Users

Developers who run several Claude Code sessions at once, each in a separate
project. The situation that defines the product: four or more sessions in
flight, any of which can stop dead waiting for a permission decision, with no
way to tell which one needs attention without checking each in turn.

The job is keeping every session moving. That means deciding permissions
quickly, knowing at a glance which project is blocked, and reading what the
model actually said instead of scrolling through build output.

Public distribution is a goal, so a developer who installs the release without
ever having seen the source is a real audience. Interfaces must explain
themselves rather than assume familiarity with the codebase.

## Product Purpose

Host every Claude Code session in one window, route every blocking approve or
deny decision into a single inbox, and show only the output that carries
meaning. The application replaces a grid of terminal windows with one control
room.

Success means the developer loses no time to window management and never leaves
a session silently blocked.

## Positioning

Switchboard launches and hosts the sessions itself through the official Claude
Agent SDK, rather than attaching to terminals someone else started. That choice
is the mechanism: because the SDK exposes a structured permission callback, the
application can intercept a request, classify its risk, apply a standing rule,
and relay the decision back to the originating session.

A terminal multiplexer can tile windows. It cannot see a permission request,
reason about it, or answer it on the developer's behalf.

## Operating Context

- Windows desktop. Requires an authenticated Claude Code installation and Node
  22.5 or newer (`package.json` engines). Current version 0.18.0.
- A project may run as many sessions as the developer starts. They appear as
  subsession rows inside the project's own row in the sidebar, and one of them is
  focused at a time: the focused session is what the centre pane, the composer and
  the header show, and clicking another row moves the focus.

  This reverses an earlier boundary, and the reversal is recorded rather than
  quietly applied. Until 2026-08-05 this section read "exactly one session per
  project", described that as a deliberate decision rather than a pending question,
  and told future work not to treat the limit as a gap to close. The owner directed
  the change on that date. Anything reading the old rule as still binding is reading
  a superseded document.

  Two consequences are open rather than settled, and should not be mistaken for
  finished thinking. There is no ceiling on the number of concurrent sessions: each
  one is a CLI child process and each bypass session is a WSL container, so a
  ceiling is a product decision nobody has taken yet, and the code deliberately does
  not invent one. And retention still speaks of "the current and previous session per
  project", which was unambiguous when a project had one at a time; with several
  running, what that phrase should keep is undecided.
- Closing the window hides the application to the system tray and sessions keep
  running, with notifications and the inbox still live. An explicit quit warns
  when sessions are mid-task, then ends them, and their conversation context
  resumes on the next launch.
- All data lives in local SQLite under the user profile at
  `%APPDATA%\terminal-switchboard\switchboard.db`, protected by the operating
  system account boundary and disk encryption rather than by application
  cryptography.
- Sessions granted bypass permissions run inside a disposable Linux container,
  because no operating system sandbox exists on native Windows. The runtime is
  WSL container (`wslc`), which ships inside WSL and requires WSL 2.9.3 or newer;
  it replaced Docker Desktop on 2026-08-19. Any project may opt into the same
  container for its section work through one switch in its header. The container's
  memory ceiling is a setting, read at session start, so a change applies to the
  next containerised session rather than the running one.

  One guarantee was lost with Docker and is not yet recoverable: wslc implements
  no capability dropping (`--cap-drop`) and no privilege-escalation bar
  (`--security-opt`), verified against `wslc run --help` on 2.9.4.0. What partly
  replaces it is that wslc gives each session its own utility virtual machine
  rather than sharing one, which is a stronger boundary and a different one.

  Two others survived the move by another route. The process-table cap is back
  as `--ulimit nproc`, which bounds a fork bomb per UID rather than per cgroup;
  the container runs as one unprivileged user, so the difference is small. And
  the memory ceiling holds without `--memory-swap`, because the WSL kernel
  reports no swap-limit capability at all, so there is no swap allowance for a
  missing flag to leave unpinned.

  WSL container is in public preview until its general availability, targeted at
  autumn 2026. Sizes must be given with an uppercase unit (`6G`, not `6g`); the
  app normalises the setting, so a value stored either way works.
- Retention runs automatically: raw output for the current and previous session
  per project, and decision history for 30 days.
- Updates arrive in-app from the GitHub release feed.

## Capabilities and Constraints

Confirmed functionality:

- A persistent project sidebar. Each row carries session status (working, needs
  you, done, error), the git branch, working-tree diff size, an activity timer,
  and a subscription usage meter. It collapses to a narrow rail of project
  initials, and carries the theme toggle.
- A central inbox holding every blocking decision, meaning tool permission
  requests and plan approvals. Questions from a session are deliberately not in
  the inbox; they render in the session stream and drive the "needs you" status.
- A session type chosen per project when the project is added, and changeable
  afterwards in Settings: default, auto, accept edits, plan first, or bypass. It
  is one value because the underlying SDK takes one permission mode, so an
  earlier pair of independent bypass and plan toggles could describe a session
  that could not be spawned. Which one is in force decides how much of the
  inbox's work reaches the inbox at all: under default every tool call arrives,
  under auto the CLI's own classifier decides first, and under bypass nothing
  arrives because nothing is gated. Projects that predate the setting were
  backfilled to auto, which is what every session already ran as.
- Risk classification as low, medium, or high, by first-match rules the
  developer edits. Anything no rule matches is treated as high risk. High-risk
  approvals require an explicit confirmation step. This applies to the requests
  that reach the inbox, so the session type above governs how much it sees.
- Standing "always allow" rules scoped to a project, by command prefix, path
  glob, exact input, or tool. There are no global rules, and high-risk actions
  cannot become standing rules.
- Pending items within a project group appear oldest first, so the
  longest-blocked work clears first.
- A clean output view that hides noise behind collapsible blocks labelled by
  kind, driven by editable global and per-project rules. Errors and
  inbox-bound items are categorically exempt. The raw stream is a read-only log,
  always one toggle away.
- A composer that accepts input mid-task, marks messages as pending delivery,
  and sends them when the session is ready. Undelivered messages survive a quit
  as drafts. A queued message can still be reworded or withdrawn before it goes.
- Spec Kit integration showing each feature spec with task progress and open
  clarifications, and dispatching each pipeline stage into the session.
- A verification section that dispatches test suites through the session and
  reports what the run measured, across six gates.
- A Diff tab, live-session-only, listing every changed file in the project's
  working tree (tracked and untracked alike) with added and removed line counts,
  grouped by folder, and showing one selected file's diff on demand. Read-only:
  no stage, discard, or revert action.
- A Cleanup tab: a launcher for curated code-review and cleanup commands drawn
  from plugin catalogues. Each group is install-aware, offering a per-project
  install when the plugin's commands are absent from the session, and each row
  is separately gated on the session actually offering that command. Output
  streams into a background session shown inline.
- A Diagrams tab: describe a diagram in a sentence and a background session
  draws it with the diagram-design plugin as a standalone HTML file inside the
  project's own `docs/diagrams`. Finished diagrams are listed newest first and
  preview in a sandboxed frame that refuses scripts twice over, by carrying no
  `allow-scripts` and by falling under the application's own content security
  policy. Drawing is not a slash command, because the skill activates on an
  ordinary request; the plugin's export and import commands are offered
  separately.
- A Database MCP section: one global view and chat over the MCP servers ticked
  in Settings, bound to a reserved project so its session outlives view
  switches.

Present but provisional, recorded so future work knows they exist and knows they
are not yet load-bearing. Neither has been lived with long enough to confirm, and
either may be withdrawn:

- **Session transcripts.** Each session exports a markdown copy of its prompt and
  reply spine, plus a mechanically counted digest, to a temporary file that is
  rewritten as the conversation lands and expires twelve hours after its last
  write. A developer can save one on demand and carry the newest one into a new
  session, which receives the digest inline and the file path for detail. The
  export reads the already-persisted events rather than keeping a second live log,
  so the file cannot disagree with the database; that constraint holds for as long
  as the feature does.
- **Heavy subagent mode.** An off-by-default setting that instructs every hosted
  session to decompose work and dispatch the independent parts in one batch across
  as many subagents as the work allows. It spends more total tokens than a single
  thread, which is the trade the setting exists to make.

Terminology and standing rules the code enforces:

- A figure no run measured is reported as unmeasured. The application never
  derives, estimates, or substitutes one.
- An environment limitation is named before a run, never reported afterwards as
  a failure of the developer's code.

Structural constraints a redesign may not trade away. Confirmed by the developer
on 2026-08-13 when directing a replacement of the visual world, which is why they
sit in product truth rather than in a visual record that a redesign replaces:

- **The three-pane control room.** Project sidebar, centre pane, inbox rail, and
  the status bar under all three. Seeing every session at once is the product's
  entire reason to exist, so this layout is not available to be composed away.
- **All six sections, still working.** Session, Specs, Tests, Diff, Cleanup and
  Diagrams all survive with their behaviour intact. None may be dropped to reach
  a cleaner composition.
- **Information density.** The application is watched for hours with many
  sessions in flight. Airy, spacious, marketing-grade whitespace makes it worse
  at its job, not better. Density is a requirement, not a style preference.

Technical constraints:

- All Claude Agent SDK usage stays in the Electron main process. The renderer
  communicates only through a typed IPC bridge with validated push channels.
- The renderer runs with context isolation, no Node integration, sandbox on, and
  a strict content security policy. Only files under `src/renderer/stores/` may
  call `invoke`, which lint enforces.
- No native modules, so there is no rebuild step. The store uses the runtime's
  own `node:sqlite`.
- Sessions must pass an explicit path to the standalone Claude Code executable.
  The SDK's own default crashes under Electron with a V8 snapshot assertion.

Explicitly undecided: code signing for distributed builds. Public distribution
remains the goal, so an unsigned installer is a known open question rather than a
settled position.

## Brand Commitments

- Name: Switchboard. Package name: `terminal-switchboard`. Author: Haefele
  Software. Licence: UNLICENSED and private.
- The shipped application is the visual authority. The design project exports
  that seeded it are evidence, not a specification, and the application has
  deliberately moved past them in places.
- **No visual register is binding.** Nothing in the shipped look is protected by
  product truth: palette, typeface, corner geometry, rule weights, density,
  elevation and the terminal register are all replaceable, and the incumbent
  world is evidence and anti-reference rather than specification.

  This has now been pinned and released twice, and both cycles are recorded so
  neither reads as still binding. The full register, monospace plus square
  corners plus hairline rules plus tabular figures, was pinned on 2026-08-05 and
  released the same day. A narrower pin, the two-theme palette plus JetBrains
  Mono, was made on 2026-08-13 and released by the developer the same day when
  directing a complete replacement of the visual world. A future pass may pin a
  register again, and that pin belongs here rather than only in DESIGN.md.
- **Worlds built and rejected.** Recorded so no later pass re-proposes one as
  though it were fresh, and so each stays available as anti-reference.

  - **The Engraved Score**, music notation. Replaced.
  - **The Deployable Sheet**, a Miura-fold sheet on a carbon ground with foil
    green as the one action colour. Replaced 2026-08-13. It reappeared as a dealt
    challenger the same day and was declined on the factual ground that it was
    the incumbent.
  - **The Sixteen-Colour Field**, an indexed sixteen-ink PC-98 palette with the
    DotGothic16 bitmap face and ordered dither as the only midtone. Chosen by the
    developer over both the roll's assignment and the pick, built as far as its
    token layer, and rejected by the developer on 2026-08-13 after seeing it on a
    populated board. The cost was named at selection and is what killed it: a
    16-dot face cannot render below 12px, so every type tier rose a step and spent
    the horizontal room that six lanes and a filesystem path need. On the
    populated board the project name and its path both truncated. Density is a
    hard requirement here, so a world that spends it is disqualified however well
    it reads on an empty board.

  The lesson generalises past these three, and any future candidate is measured
  against it: this interface is judged populated, never empty. A world whose
  legibility floor forces a larger type scale cannot hold six lanes, a branch, a
  path, a timer and a count on one row.
- One requirement that outlives any register: state must remain readable without
  relying on colour alone. It is carried by the WCAG 2.2 AA target recorded under
  Accessibility and Inclusion, in which Success Criterion 1.4.1 Use of Colour
  sits at level A. Changing it needs an explicit change to the accessibility
  target, not to this section.
- Voice: action first, numbered when there are steps, no preamble and no
  closing pleasantries. This applies both to the application's own copy and to
  the sessions it hosts.

## Evidence on Hand

Real artefacts available to future work:

- `specs/001-terminal-switchboard/`, holding the specification, plan, data
  model, contracts, and tasks, including a recorded clarification session that
  settled the scope questions above.
- `specs/002-tests-qa-section/` for the verification surface.
- `docs/screenshot.png`.
- `src/renderer/design.html`, a development-only page that boots the real
  renderer against the end-to-end mock IPC host. It is the only way to style the
  interface in a plain browser, because every store talks through a bridge that
  only the Electron preload provides.
- `design-lab/`, a local server and page for arguing about the design.
- A claude.ai design project holding `Switchboard App.dc.html`, the interactive
  design source the shipped interface was aligned to.
- Test suites, re-measured on 2026-08-13 for 0.18.0: 640 passing unit tests
  across 67 files with 3 skipped, and 224 Playwright end-to-end tests across 29
  files, 215 passing and 9 skipped, run against the mock session host in
  `tests/e2e/mock-host.ts` rather than against live sessions. A separate
  `npm run test:real` suite is the only one that exercises the real IPC bridge;
  its count was not re-measured for this record and no figure is claimed for it.
  Treat the suites as the authority, never these figures.

Removed on 2026-08-13, at the developer's instruction. Future work must not cite
them as present or quote their content:

- `DESIGN.md` and `DESIGN-BRIEF.md`, which held the visual record and a brief
  readable without the repository.
- `FUNCTIONALITY.md`, a control-by-control functional reference.
- `README.md`.
- `docs/security-review.md` and `docs/verification-research.md`, both of which an
  earlier version of this record cited under this heading.
- `design-lab/NOTES.md`.

Every one of these is recoverable from git history, which is a fact about the
repository and not a licence to treat them as current.

Absences that future work must not fabricate: there are no testimonials, no
user research, no adoption figures, no performance benchmarks, and no published
pricing. None of these exist, and none may be invented or implied. No WCAG
conformance has been audited, so none may be claimed.

## Product Principles

1. **One place for every decision.** Anything that blocks a session goes to the
   inbox. Nothing waits in a window nobody is looking at.
2. **Never report what was not measured.** An unmeasured figure stays visibly
   unmeasured, and an environment limit is disclosed before the run rather than
   dressed up as a failure afterwards.
3. **The developer owns the rules.** Risk classification, output swallowing, and
   standing permissions ship as editable defaults, never as fixed policy.
4. **Nothing leaves the machine.** Storage is local, the application sends no
   telemetry, and desktop notifications carry no more than a project name and an
   item title.
5. **Work in progress survives the interface.** Closing the window keeps
   sessions alive, quitting warns first, and drafts and conversation context
   come back on the next launch.

## Accessibility & Inclusion

**WCAG 2.2 level AA is the named target.** Keyboard operation and screen reader
support are product requirements underneath it: every action reachable by keyboard
with a visible focus indicator, and labels, roles and live regions wherever state
changes without focus moving.

This records the target, not conformance. Nothing has been audited against WCAG
2.2 AA, and no conformance claim may be made or implied on the strength of this
line. Accessibility attributes currently appear in 15 of 22 renderer components
and views, counted on 2026-08-13, up from 11 of 18. Surfaces are expected to fall
short until they are revisited and measured.
