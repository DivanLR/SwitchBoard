# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

The interface is a Vue 3 renderer inside an Electron shell on Windows. It is web
technology in a desktop wrapper, so it follows web design language rather than a
native iOS or Android one.

## Users

A developer who builds .NET APIs and Angular front ends with Claude Code, runs
several sessions at once across several repositories, and wants one place to
take a feature from an idea or an Azure DevOps Feature to a tested pull request.

Two situations define the product. The first: four or more sessions in flight,
any of which can stop dead waiting for a permission decision, with no way to tell
which one needs attention without checking each in turn. The second: a feature
that has to travel through the same steps every time (specify it, plan it, build
it, clean it up, test it, review it, raise the pull request), each step driven by
a skill the developer already trusts, and each step easy to forget or to do out
of order when it is typed by hand into a chat.

Public distribution is a goal, so a developer who installs the release without
ever having seen the source is a real audience. Interfaces must explain
themselves rather than assume familiarity with the codebase.

## Product Purpose

Host every Claude Code session in one window, route every blocking approve or
deny decision into a single inbox, show only the output that carries meaning,
and run a feature through a fixed, visible pipeline from specification to pull
request in its own git worktree.

Success means the developer loses no time to window management, never leaves a
session silently blocked, and can hand a feature to Flow before stopping for the
day and find it specified, built, cleaned, tested and reviewed on return, with
the pull request one click away.

## Positioning

Switchboard launches and hosts the sessions itself through the official Claude
Agent SDK, rather than attaching to terminals someone else started. That choice
is the mechanism: because the SDK exposes a structured permission callback, the
application can intercept a request, classify its risk, apply a standing rule,
and relay the decision back to the originating session.

Flow does not reimplement the developer's tools. Every stage sends the same slash
commands the developer types by hand (Spec Kit, dotnet-claude-kit, ponytail), in
a fresh session per stage, and asks each stage to report its result in one
machine readable line. The application measures what it can (task checkboxes, the
verification report) and never invents a figure it did not measure.

## Operating Context

- Windows desktop. Requires an authenticated Claude Code installation and Node
  22.5 or newer (`package.json` engines). The version is in `package.json`.
- The scope is .NET and Angular. Flow refuses a project in which it finds neither
  a solution or project file nor an `angular.json`, and the Tests section offers
  only those two stacks.
- A project may run as many sessions as the developer starts. They appear as
  subsession rows inside the project's own row in the sidebar, and one of them is
  focused at a time. There is no ceiling on concurrent sessions; each is a CLI
  child process, so a ceiling remains a product decision nobody has taken yet.
- Closing the window hides the application to the system tray and sessions keep
  running, with notifications and the inbox still live. An explicit quit warns
  when sessions are mid task, then ends them, and their conversation context
  resumes on the next launch.
- All data lives in local SQLite under the user profile at
  `%APPDATA%\terminal-switchboard\switchboard.db`, protected by the operating
  system account boundary and disk encryption rather than by application
  cryptography.
- Every session runs under one of six permission modes: default, auto, accept
  edits, plan first, do not ask, and bypass. A session runs on the host unless
  its project ticks Run in Container; bypass always runs in a disposable WSL
  container, and at most two containers run at once. Every Flow session, and
  any session that works in a folder other than the project's own, runs on the
  host, because a container mounts only the project folder and a Flow run works
  in its worktrees; a bypass project gives it accept edits instead, and the Flow
  intake says so in one line.
- Section work runs in the section's own session, not in the conversation, so a
  verification pass does not block the chat. A drawing and every Flow stage take
  a fresh session each; a Flow stage's session ends when its stage finishes.
- Flow creates one git worktree and one branch per run, by default in a sibling
  folder `<repository>.worktrees\<slug>` so that nested copies of test projects
  are never swept up by a `dotnet test` glob in the main checkout. A setting
  overrides the root. The worktree branches from the committed head of the base
  branch; uncommitted work in the main checkout is not carried over.
- A Flow run belongs to the project it was opened from, where the spec lives,
  and may also change other registered projects (the everyday case is an
  Angular front end with a .NET API). Each of them gets its own worktree in its
  own sibling folder on the same branch name, with its own base branch; the
  stage sessions work in the primary worktree and see the others as extra
  directories, and the Ship stage raises one pull request per repository.
- Retention runs automatically: raw output for the twelve most recent sessions
  per project, decision history for 30 days, and the twenty most recent Flow runs
  per project. A project archived more than 30 days ago is deleted from
  Switchboard, never from disk.
- Updates arrive in-app from the GitHub release feed. Plugins, imported skills
  and Spec Kit extensions are checked shortly after start and then daily, unless
  Settings, General switches it off.

## Capabilities and Constraints

Confirmed functionality:

- A persistent project sidebar with groups. Each row carries session status
  (working, needs you, done, error), the git branch, working tree diff size, an
  activity timer and a subscription usage meter. It collapses to a narrow rail
  and carries the theme toggle.
- A central inbox holding every blocking decision, meaning tool permission
  requests and plan approvals. Questions from a session render in the session
  stream (or in the Flow popup, for a Flow stage) and drive the "needs you"
  status.
- Risk classification as low, medium or high by first match rules. Anything no
  rule matches is treated as high risk. High risk approvals require an explicit
  confirmation step. Low and medium risk may be auto approved by setting.
- Standing "always allow" rules scoped to a project, by command prefix, path
  glob, exact input, or tool. There are no global rules, and high risk actions
  cannot become standing rules.
- A clean output view that hides noise behind collapsible blocks labelled by
  kind, a raw view, and a terminal view of the same conversation. The terminal
  view can drop into a real shell and hand a session over to the Claude Code CLI
  with `claude --resume`; a live SDK session never gets a second CLI process.
- A composer that accepts input mid task, queues it, and sends it when the
  session is ready, with slash command suggestions, project references and an
  "up next" queue. Undelivered messages survive a quit as drafts.
- Model modes: auto, advisor, orchestrator and basic pair an intelligent model
  with a worker model. The session runs one main loop model chosen from the mode,
  and reaches the other tier through the advisor and worker subagents; it is
  never switched between turns unless the setting itself changes. Pair models by
  message reports the pattern each turn picks as an Advisor or Orchestrator chip.
  A Diff comment runs on the worker model. On a usage limit the session drops to
  the next strongest model instead of stopping. Subagents are allowed only at
  maximum effort, enforced by a hook, and maximum subagent effort adds a fan out
  directive.
- **Flow**, a large popup opened from the session header, which takes one
  feature through seven stages, each a fresh Claude Code session in the run's
  worktree:
  1. Spec: `/speckit-specify`, then `/speckit-clarify`.
  2. Plan: `/speckit-plan` with the stack's conventions, `/speckit-tasks`,
     `/speckit-analyze`.
  3. Build: `/speckit-implement-scaffold` for .NET, `/speckit-implement` for
     Angular.
  4. Clean: `/dotnet-claude-kit:de-sloppify` on the branch's changes, then
     `/ponytail:ponytail-review` of the branch diff.
  5. Test: write the missing tests (and a Postman collection when endpoints
     change), then the verification report for the detected stacks.
  6. Review: `/dotnet-claude-kit:code-review` and
     `/dotnet-claude-kit:security-scan`, with a verdict, findings and every
     acceptance criterion the code does not meet.
  7. Ship: commit, push and open the pull request (Azure Repos through the ado
     MCP server, or GitHub through `gh`), never merged, approved or given
     reviewers.
  A feature writes the constitution first when the project has none, builds
  with implement then `/speckit-converge`, repeated until converge reports
  Converged (at most three rounds), and may hold the plan on a checklist gate.
  A run is one of three kinds, chosen first in the intake. A bug runs assess,
  fix and test (`/speckit-bug-assess`, `-fix`, `-test` on one slug), then the
  same clean, review and ship; its test stage fails unless the bug test records
  verified. An idea runs intake, research, define, shape and decide
  (`/speckit-assess-*`) in the project's own checkout, with no worktree and no
  branch, and a go decision offers to start a feature seeded with the decision.
  A run starts from an Azure DevOps Feature, a written description, or an
  existing Spec Kit folder. When the ado MCP server is not connected, Flow says
  whether it is still starting (it waits up to 90 seconds, since npx can be
  slow), needs sign in, or failed with its own error, and offers Reconnect,
  which reconnects it on the same session and asks for the Features again.
  Each stage waits for approval unless autopilot is on;
  autopilot allows at most two automatic fix rounds on review, retries a lost
  session once, and stops before the pull request unless the developer also
  chose to raise it at the end.
- An SDD tab over the project's Spec Kit folders, in three processes. Features
  (`specs/<id>/`) shows the spec, plan, tasks progress, clarifications and the
  converge state; Bugs (`.specify/bugs/<slug>/`) shows each report and the final
  verdict; Ideas (`.specify/assessments/<slug>/`) shows each assessment and its
  decision. It says whether the constitution is written, offers to write it,
  runs every command of each process in a fresh session, installs the bug and
  assess extensions with `specify extension add`, and opens a feature, bug or
  idea in Flow.
- Two engines: Claude Code and Codex, chosen for new sessions in Settings,
  Models and per session in the start panel.
- Skills: Settings, Skills imports skills from any GitHub skills folder, groups
  them by source, and switches or removes each one; an imported skill is a slash
  command in every session. The Skills tab runs a skill in its own background
  session, with favourites at the top.
- Plugins, imported skills and Spec Kit extensions are kept current: checked
  shortly after start and then daily, with every result listed in Settings,
  General. A plugin update that needs a marketplace command confirmed is
  reported, never accepted automatically. Updates apply to sessions started
  afterwards.
- A project can be deleted from Switchboard (never from disk) once it has no
  live session and no Flow run that owns a worktree; an archived project is
  deleted automatically after 30 days.
- A Tests section that dispatches the .NET or Angular suites through a session
  and reports what the run measured, gate by gate.
- A Diff tab, live session only, listing every changed file in the working tree
  with added and removed line counts, grouped by folder, showing one file's diff
  on demand and sending a selected region with a comment to a session.
- A Diagrams tab: describe a diagram in a sentence and a background session draws
  it as a standalone HTML file inside the project's own `docs/diagrams`, previewed
  in a sandboxed frame that refuses scripts.
- A Database MCP section: one global view and chat over the MCP servers ticked in
  Settings, bound to a reserved project so its session outlives view switches.
- A session can hand work to another open project; the receiving session is
  started and shown, never left in an invisible queue.
- Session transcripts. Each session exports a markdown copy of its prompt and
  reply spine to a temporary file, rewritten as the conversation lands and
  deleted twelve hours after its last write, so a crash leaves one behind. The
  export reads the already persisted events rather than keeping a second live
  log. The start panel of an ended Claude session offers Carry last transcript:
  the new session gets its digest in its instructions and the file's path to
  read on demand. A container session gets the digest only, because the file is
  on this machine; a resume and a Codex start carry nothing extra.

Terminology and standing rules the code enforces:

- A figure no run measured is reported as unmeasured. The application never
  derives, estimates, or substitutes one.
- An environment limitation is named before a run, never reported afterwards as
  a failure of the developer's code.

## Scope Decisions

**2026-09-23, the developer assistant redesign.** Directed by the owner in these
words: "I want to fully redesign and rework my whole app. The whole point of it
is that this is a developer assistant, a way to streamline my development from
start to end and then to fully test what I have built. Limit it to .NET and
Angular [...] It has gotten very bloated and has all these functions which I do
not use. Simplify it, clean it up and make sure everything has a use. Improve my
flow system so that I can take Features to Specs to Product and produce tests."

Removed, and still removed, each on the evidence of the application's own
database on that date:

- The in-app evaluation loop (Manual QA evals) and the API test runner: no run
  ever recorded.
- The Security tab: no audit ever run, and it depended on a skill that was never
  installed. Security scanning happens inside Flow's review stage.
- The Cleanup tab: no cleanup session ever started. Cleanup happens inside
  Flow's clean stage.
- The rule preference layer and the MCP scan history: neither could ever be
  written from the interface.
- Test stacks other than .NET and Angular.
- The earlier Flow (Azure DevOps Feature to backlog items, cross check, parallel
  worktrees, pull requests, lessons into CLAUDE.md): never run once. On
  2026-09-21 the owner asked for Flow to become "a popup screen that lets me run
  through features and setup my specs", which the new Flow is.

Removed overnight and **restored the same morning** at the owner's direction.
The lesson is recorded so no later pass repeats it: a feature that lets a person
bring their own tools, or that protects them, is not "unused" because the
owner's own database shows few rows.

- The WSL container sandbox and bypass mode: "do not remove sandbox containers
  as a feature".
- Skill import and management in Settings, and the Skills section tab: "I still
  want every person to import their own skills - its a feature allowing people
  to use their own stuff".
- The Codex engine beside Claude: "I no longer have the option to have both
  Claude and Codex in use". Codex never runs in a container or in bypass, and
  Flow, Tests, Diff, Diagrams, Skills and SDD sessions always run on Claude Code.
- Model modes (auto, advisor, orchestrator, basic) with the worker model and
  Pair models by message.
- Session transcripts with the carry switch in the start panel.
- The Specs tab, restored as the SDD tab, at the direction that all three Spec
  Kit processes (Spec-Driven Development, Bug fixing, Idea assessment) be "part
  of my SDD for flow and for SDD tab".

Added the same day at the owner's direction: Flow across several repositories
("Flow should be able to span 2 REPOs"), the Feature, Bug and Idea kinds in
Flow, deleting a project with automatic deletion after 30 days in the archive,
keeping plugins, imported skills and Spec Kit extensions current daily and at
start, full effort sliders, and a Reconnect path for the Azure DevOps MCP
server.

This supersedes the constraint recorded on 2026-08-13 that "all six sections"
(Session, Specs, Tests, Diff, Cleanup, Diagrams) must survive. The sections now
are Session, Tests, Diff, Diagrams, Skills and SDD, with Flow as a popup and the
Database MCP view alongside. Anything reading the six section rule as binding is
reading a superseded document.

Structural constraints a redesign may not trade away, confirmed by the developer
on 2026-08-13 and still in force:

- **The three pane control room.** Project sidebar, centre pane, inbox rail, and
  the status bar under all three.
- **Information density.** The application is watched for hours with many
  sessions in flight. Airy, spacious, marketing grade whitespace makes it worse
  at its job, not better.

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

Explicitly undecided: code signing for distributed builds. On 2026-09-23 the
owner decided that one Flow run may span two or more repositories.

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

  This has been pinned and released twice, and both cycles are recorded so
  neither reads as still binding. The full register, monospace plus square
  corners plus hairline rules plus tabular figures, was pinned on 2026-08-05 and
  released the same day. A narrower pin, the two theme palette plus JetBrains
  Mono, was made on 2026-08-13 and released by the developer the same day when
  directing a complete replacement of the visual world. A future pass may pin a
  register again, and that pin belongs here rather than only in DESIGN.md.
- **Worlds built and rejected.** Recorded so no later pass re-proposes one as
  though it were fresh, and so each stays available as anti-reference.

  - **The Engraved Score**, music notation. Replaced.
  - **The Deployable Sheet**, a Miura fold sheet on a carbon ground with foil
    green as the one action colour. Replaced 2026-08-13. It reappeared as a dealt
    challenger the same day and was declined on the factual ground that it was
    the incumbent.
  - **The Sixteen Colour Field**, an indexed sixteen ink PC-98 palette with the
    DotGothic16 bitmap face and ordered dither as the only midtone. Built as far
    as its token layer and rejected by the developer on 2026-08-13 after seeing
    it on a populated board: a 16 dot face cannot render below 12px, so every
    type tier rose a step and the project name and its path both truncated.

  The lesson generalises: this interface is judged populated, never empty. A
  world whose legibility floor forces a larger type scale cannot hold a branch,
  a path, a timer and a count on one row.
- One requirement that outlives any register: state must remain readable without
  relying on colour alone. It is carried by the WCAG 2.2 AA target recorded under
  Accessibility and Inclusion, in which Success Criterion 1.4.1 Use of Colour
  sits at level A.
- Voice: action first, numbered when there are steps, no preamble and no
  closing pleasantries. This applies both to the application's own copy and to
  the prompts it sends to the sessions it hosts.

## Evidence on Hand

- `specs/001-terminal-switchboard/` and `specs/002-tests-qa-section/`, the
  original specifications (gitignored; present in the owner's checkout).
- `docs/screenshot.png`.
- `src/renderer/design.html`, a development only page that boots the real
  renderer against the end to end mock IPC host, including seeded Flow runs. It is
  the only way to style the interface in a plain browser.
- `design-lab/`, a local server and page for arguing about the design.
- The test suites: Vitest unit tests, Playwright end to end tests against the mock
  host in `tests/e2e/mock-host.ts`, the real Electron suite (`npm run test:real`),
  and two opt-in real session smoke tests (`REAL_SESSION=1`), one of which runs a
  Flow spec stage end to end in a throwaway repository. Treat the suites as the
  authority for counts; this document claims none.

Absences that future work must not fabricate: there are no testimonials, no
user research, no adoption figures, no performance benchmarks, and no published
pricing. No WCAG conformance has been audited, so none may be claimed.

## Product Principles

1. **One place for every decision.** Anything that blocks a session goes to the
   inbox. Nothing waits in a window nobody is looking at.
2. **Never report what was not measured.** An unmeasured figure stays visibly
   unmeasured, and an environment limit is disclosed before the run rather than
   dressed up as a failure afterwards.
3. **The developer's own tools do the work.** Flow sends the skills the developer
   already uses and follows the repository's own conventions and CLAUDE.md; it
   does not carry a private copy of them.
4. **Everything has a use.** A feature that the application's own records show
   nobody uses is removed rather than kept "for later".
5. **Nothing leaves the machine** except what the developer's own sessions send.
   Storage is local, the application sends no telemetry, and desktop
   notifications carry no more than a project name and an item title.
6. **Work in progress survives the interface.** Closing the window keeps
   sessions alive, quitting warns first, and drafts, conversation context and
   Flow runs come back on the next launch.

## Accessibility & Inclusion

**WCAG 2.2 level AA is the named target.** Keyboard operation and screen reader
support are product requirements underneath it: every action reachable by keyboard
with a visible focus indicator, and labels, roles and live regions wherever state
changes without focus moving.

This records the target, not conformance. Nothing has been audited against WCAG
2.2 AA, and no conformance claim may be made or implied on the strength of this
line.
