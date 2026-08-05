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
- Exactly one session per project. This is a deliberate product boundary, not a
  pending question: parallel sessions within a single project were considered and
  decided against, so future work should not treat the limit as a gap to close.
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
- Risk classification as low, medium, or high, by first-match rules the
  developer edits. Anything no rule matches is treated as high risk. High-risk
  approvals require an explicit confirmation step.
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
- **The terminal register is binding**, pinned by the developer on 2026-08-05:
  monospace for machine-read text, square corners, tabular figures, hairline
  rules, and state that reads without relying on colour. A full replacement of
  the visual world was considered on the same day and set aside in favour of this
  commitment, so later work refines inside this register rather than proposing a
  different one. DESIGN.md holds the detail; this line records only that the
  register itself is a commitment and not a passing preference.
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
- A test suite of 487 passing unit tests across 52 files (2 skipped), plus 162
  Playwright end-to-end tests that run against the mock session host in
  `tests/e2e/mock-host.ts` rather than against live sessions. A separate
  `npm run test:real` suite is the only one that exercises the real IPC bridge.
  These counts are a snapshot; treat the suites as the authority, not the figures.

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
line. Accessibility attributes currently appear in 10 of 17 renderer components,
up from 5, so surfaces are expected to fall short until they are revisited and
measured.
