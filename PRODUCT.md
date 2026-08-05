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
  22.5 or newer (`package.json` engines).
- A project may run as many sessions as the developer starts. They appear as
  subsession rows inside the project's own row in the sidebar, and one of them is
  focused at a time: the focused session is what the centre pane, the composer and
  the header show, and clicking another row moves the focus.

  This reverses the previous boundary, and the reversal is recorded rather than
  quietly applied. Until 2026-08-05 this section read "exactly one session per
  project", described that as a deliberate decision rather than a pending question,
  and told future work not to treat the limit as a gap to close. The owner directed
  the change on that date. Anything reading the old rule as still binding is reading
  a superseded document.

  Two consequences are open rather than settled, and should not be mistaken for
  finished thinking. There is no ceiling on the number of concurrent sessions: each
  one is a CLI child process and each bypass session is a Docker container, so a
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
- Sessions granted bypass permissions run inside a disposable Docker Linux
  container, because no operating system sandbox exists on native Windows. This
  requires Docker Desktop to be running. The container's memory ceiling is a
  setting, read at session start, so a change applies to the next bypass session
  rather than the running one.
- Retention runs automatically: raw output for the current and previous session
  per project, and decision history for 30 days.
- Updates arrive in-app from the GitHub release feed.

## Capabilities and Constraints

Confirmed functionality:

- A persistent project sidebar. Each row carries session status (working, needs
  you, done, error), the git branch, working-tree diff size, an activity timer,
  and a subscription usage meter.
- A central inbox holding every blocking decision, meaning tool permission
  requests and plan approvals. Questions from a session are deliberately not in
  the inbox; they render in the session stream and drive the "needs you" status.
- A session type chosen per project when the project is added, and changeable
  afterwards in Settings: default, auto, accept edits, plan first, or bypass. It
  is one value because the underlying SDK takes one permission mode, so the
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
  as drafts.
- Spec Kit integration showing each feature spec with task progress and open
  clarifications.
- A verification section that dispatches test suites through the session and
  reports what the run measured.
- A Diff tab, live-session-only, listing every changed file in the project's
  working tree (tracked and untracked alike) with added/removed line counts,
  and showing one selected file's diff on demand. Read-only: no stage,
  discard, or revert action.

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

Technical constraints:

- All Claude Agent SDK usage stays in the Electron main process. The renderer
  communicates only through a typed IPC bridge with validated push channels.
- The renderer runs with context isolation, no Node integration, and a strict
  content security policy.
- No native modules, so there is no rebuild step. The store uses the runtime's
  own `node:sqlite`.

Explicitly undecided: code signing for distributed builds. Public distribution
remains the goal, so an unsigned installer is a known open question rather than a
settled position.

## Brand Commitments

- Name: Switchboard. Package name: `terminal-switchboard`. Author: Haefele
  Software. Licence: UNLICENSED and private.
- The shipped application is the visual authority. The original mockup exports
  that seeded the design are historical evidence, not a specification, and the
  application has deliberately moved past them in places.
- **No visual register is binding.** The terminal register (monospace for
  machine-read text, square corners, tabular figures, hairline rules, state
  readable without colour) was pinned on 2026-08-05 and released in full by the
  developer on the same day, who directed a complete redesign and chose to
  release every part of it. Nothing in the shipped look is therefore protected
  by product truth: monospace, square corners and hairline rules are all
  replaceable, and the incumbent world is evidence rather than specification.
  A future pass may pin a register again, and that pin belongs here rather than
  only in DESIGN.md.
- One requirement the release does not reach: state must remain readable
  without relying on colour alone. That constraint outlives the register because
  it is carried by the WCAG 2.2 AA target recorded under Accessibility &
  Inclusion, which the developer separately confirmed as current on 2026-08-05.
  Success Criterion 1.4.1 Use of Colour sits at level A inside that target, so
  releasing the aesthetic commitment did not release the accessibility one.
  Changing this needs an explicit change to the accessibility target, not to
  this section.
- Voice: action first, numbered when there are steps, no preamble and no
  closing pleasantries. This applies both to the application's own copy and to
  the sessions it hosts.

## Evidence on Hand

Real artefacts available to future work:

- `specs/001-terminal-switchboard/`, holding the specification, plan, data
  model, contracts, and tasks, including a recorded clarification session that
  settled the scope questions above.
- `specs/002-tests-qa-section/` for the verification surface.
- `docs/security-review.md`, `docs/verification-research.md`, and
  `docs/screenshot.png`.
- A test suite of 512 passing unit tests across 56 files (2 skipped), plus 181
  Playwright end-to-end tests that run against the mock session host in
  `tests/e2e/mock-host.ts` rather than against live sessions. A separate
  `npm run test:real` suite of 9 tests is the only one that exercises the real IPC
  bridge. These counts are a snapshot, re-measured for the 0.15.0 release on
  2026-08-05; treat the suites as the authority, not the figures.

Absences that future work must not fabricate: there are no testimonials, no
user research, no adoption figures, no performance benchmarks, and no published
pricing. None of these exist, and none may be invented or implied.

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
line. Accessibility attributes currently appear in 11 of 18 renderer components
and views, up from 5, counted after the Diff tab merged on 2026-08-05. Surfaces
are expected to fall short until they are revisited and measured.
