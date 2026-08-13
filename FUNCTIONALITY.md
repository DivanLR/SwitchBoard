# Switchboard — functional reference

**What every view, panel and control in the application does.**

This document is generated against the source and checked against it: every
control listed here carries its `data-testid`, and the list was extracted
mechanically from the templates rather than written from memory. If a control is
not in here, it is not in the app.

---

## What the application is

A Windows desktop application that runs **many Claude Code sessions at once, in
one window**. Claude Code is a terminal coding agent. Normally you run one per
terminal tab and watch it. Switchboard hosts a dozen, across a dozen
repositories, and gives you one place to see what they are all doing — and one
place to answer the ones that stop and ask you something.

### Words used throughout

| Term | Meaning |
| --- | --- |
| **Project** | A folder on disk with a git repository in it. |
| **Session** | One running Claude Code agent, belonging to a project. A project may run several at once. |
| **Background session** | A session started *by a section* rather than by you, to do a job — a verification run, a diagram, an API test. Nobody opens it; its output appears in the section that asked for it. |
| **Subsession** | Any session of a project other than the one the centre pane is showing. They are listed beneath the project in the rail. |
| **Event** | One thing that happened in a session: a prompt, a reply, a tool call, an error. A session is an append-only stream of these. |
| **Permission request** | The agent wants to do something and is blocked until you answer. These arrive in the inbox. |
| **Mode** | How much a session may do without asking. Six of them, from "ask about everything" to "never ask, and run inside a Docker container". |
| **Gate** | One of the six checks the Tests section runs: unit, coverage, end-to-end, lint, mutation, API. |

### The six session modes

Chosen per project, and changeable for a single session when you start one.

| Mode | What it means |
| --- | --- |
| **Default** | Every tool call waits for you in the inbox. |
| **Don't ask** | Nothing ever interrupts you. Anything not already approved is refused rather than asked. |
| **Auto** | Claude Code's own classifier decides; only what it will not judge reaches you. |
| **Accept edits** | File edits go through without asking. Commands and deletes still come to you. |
| **Plan first** | Reads and researches without changing anything, then sends a plan to your inbox. |
| **Bypass** | Nothing asks for approval. Runs inside a disposable Docker container. |

---

## The window

Three columns, always visible.

```
┌────────────┬───────────────────────────────────────────┬──────────────┐
│            │  storefront  C:\work\storefront    [Plan] │  INBOX  3    │
│ switchboard│  branch +12 -4  session 00:04:11          │  HISTORY     │
│            ├───────────────────────────────────────────┤              │
│ [filter  ] │  SESSION SPECS TESTS DIFF CLEANUP DIAGRAMS│  ┌─────────┐ │
│            ├───────────────────────────────────────────┤  │ Edit the│ │
│ PROJECTS 6 │                                           │  │ cart... │ │
│ • storefront│          the session stream               │  │[Approve]│ │
│   fix/cart │                                           │  └─────────┘ │
│ • api-server│                                          │  ┌─────────┐ │
│   feat/auth│                                           │  │ Run the │ │
│ • ml-pipeline│                                         │  │ tests...│ │
│ • infra    │                                           │  └─────────┘ │
│            ├───────────────────────────────────────────┤              │
│ ⚙ Settings │  ❯ [ Send a message to storefront…  ] Send│              │
├────────────┴───────────────────────────────────────────┴──────────────┤
│ ● RUN 2   ● WAIT 3   │  TODAY $4.12   82k tok            ⏎ send       │
└───────────────────────────────────────────────────────────────────────┘
```

- **Left rail (276px, collapsible).** Every project, each with a status mark, its
  git branch and a running timer. Sessions nest beneath their project. Settings
  is pinned at the bottom.
- **Centre.** A header for the selected project, a strip of six section tabs, the
  section itself, and the composer pinned to the bottom.
- **Right rail (332px, resizable 280–680, collapsible).** The inbox: every
  pending permission request across every project, grouped by project. Always
  visible by default, because it is the column that says what needs you.
- **Status bar.** One line under everything: sessions running, sessions waiting,
  today's spend and token count.

### The six sections

| Section | What it is for |
| --- | --- |
| **Session** | The conversation with the agent. The default view. |
| **Specs** | GitHub Spec Kit: write a spec, break it into tasks, implement them. |
| **Tests** | Verification. Pick the project's stack, choose what to check, run it, read the six gates. Also holds the eval loop for small changes. |
| **Diff** | The project's uncommitted working-tree changes, tracked and untracked. Read-only. |
| **Cleanup** | A launcher for curated code-review and cleanup commands from installed plugins. |
| **Diagrams** | Describe a diagram; a background session draws it as a standalone HTML file in `docs/diagrams`. |

A seventh view, **Database MCP**, is reached from a reserved row in the rail
rather than from the tab strip.

---

## App shell

`App.vue` is the outer frame: it wires push events from the main process into the stores, lays out sidebar / session pane / inbox, and hosts the two full-window overlays and the update banner. Most of its data-testids are structural (they mark regions rather than being clicked); the controls that do something are the update banner's two buttons and the empty-state "add a project" button.

### Update banner

Shown whenever `updates.active` is true (an update is available, downloading, ready, or failed) and the developer has not dismissed it. Driven by `push.updateStatus` from the main process.

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Update banner** `update-banner` | Not a control: the banner itself. Its text changes with state — "downloading… N%", "the installer is opening", a failure message, or "a new version is available". | Hidden once dismissed, or once no update is active. |
| **download & install** `update-banner-install` | Calls `updates.install()`, which invokes `updates.install` over IPC. This downloads the update in-app and restarts into the installer; if the feed or download is unusable it falls back to opening the releases page. | Hidden once the update is downloading, ready, or already installing — the button only shows in the plain "available" state. |
| **Dismiss** `update-banner-dismiss` (aria: Dismiss) | Sets a local flag that hides the banner for the rest of this window session. It reappears if a fresh `push.updateStatus` arrives with a new "available" state. | Hidden once the update is ready to install (an install already in progress should not be dismissible). |

### Main pane / empty state

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **add a project** `add-project-empty` | Sets `showRegistration = true`, opening the `ProjectRegistration` dialogue (its own file, not covered here). | Shown only when no project is selected at all. |

### Inbox rail and resize

The inbox panel sits on the right and can be dragged narrower/wider, or collapsed to a thin rail. Width and collapsed state persist in `localStorage`, not the database, so they are per-machine.

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Inbox resize handle** `inbox-resize` (title: "Drag to resize the inbox") | A drag handle on the inbox's left edge. Dragging it left widens the inbox, right narrows it, clamped between 280px and 680px; the width is written to `localStorage` on release. | Hidden while the inbox is collapsed to a rail. |
| **Inbox rail** `inbox-rail` | Not a control: the collapsed 44px right rail shown in place of the full inbox. | Hidden while the inbox is expanded. |
| **Inbox peek button** `inbox-peek` | Reopens the inbox (`setInboxCollapsed(false)`), persisting the choice. Glows amber and shows the pending count when there is anything waiting; otherwise shows a plain chevron. | Only present while the inbox is collapsed. |
| **Inbox peek count** `inbox-peek-count` | Read-only figure: the number of pending inbox items, shown inside the glowing peek button. | Hidden when the pending count is zero (a plain chevron icon shows instead). |

**Note worth having**: the Database MCP session and its view are treated as a project switch — selecting any real project closes the MCP view via `projects.select` → `activeSession.openMcp(false)`, so there is no separate "close MCP" control; picking a project does it implicitly.

## Sidebar

The project rail: brand row, filter, the PROJECTS list (grouped, foldable, drag-reorderable, with per-project subsessions and parallel-agent rows), the Database MCP section, and the Settings footer. Right-clicking a project or a group opens a context menu; two further dialogues (change folder, remove project) are anchored here too.

### Header

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Theme toggle** `theme-toggle` (appears twice: expanded header and collapsed rail) | Flips a local `theme` ref between light/dark, toggles the `sb-light` class on `<html>`, and persists the choice to `localStorage`. Nothing round-trips through IPC — it is a pure CSS switch. | Always available; only its position moves between expanded and collapsed sidebar. |
| **Collapse toggle** `collapse-toggle` | Toggles the sidebar between its full 276px width and a 64px icon-only rail. | Hidden entirely when the sidebar is already collapsed (the rail has no expand button of its own beyond this one, which flips the same state). |

### Filter and list header

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Filter input** `project-filter` (placeholder: "Filter") | Narrows the visible project list by name or branch, live as the developer types. Escape clears it. | Hidden while the sidebar is collapsed. |
| **Filter clear** `project-filter-clear` (title: Clear) | Empties the filter text. | Shown only once the filter box has text in it. |
| **Project count** `project-count` | Read-only figure: how many projects currently pass the filter. | Hidden while collapsed. |
| **Add group** `new-group` (aria: Add group) | Calls `newGroup()`, which creates a new project group with an auto-generated unique name ("New group", "New group 2", …), saves it to settings, and drops straight into inline rename for it. | Hidden while the sidebar is collapsed. |
| **New session** `add-project` (title: New session) | Emits `add-project` up to `App.vue`, which opens the project-registration dialogue for adding a project and starting its first session. | Always available. |

### Groups

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Group header** `group-head-<name>` / `group-head-ungrouped` | Click folds/unfolds the group (persisted via settings); right-click opens the group context menu; it is also a drop target for dragging a project into that group. | Hidden while the sidebar is collapsed. |
| **Group rename input** `group-rename-input-<name>` | Inline-editing field for a group's name; commits on Enter or blur, cancels on Escape. | Only present while that group is mid-rename (triggered from the context menu's Rename, or automatically right after "New group"). |
| **Group pending badge** `group-badge-<name>` / `group-badge-ungrouped` | Read-only figure: total pending-inbox count summed across every project in that group. | Hidden when that sum is zero. |
| **Group count** `group-count-<name>` / `group-count-ungrouped` | Read-only figure: number of projects currently in that group (after filtering). | Hidden while collapsed. |
| **Group remove** `group-remove-<name>` (title: "Remove this group (its projects stay)") | Calls `removeGroup`, deleting the group from settings and clearing its projects' group assignment so they fall back to Ungrouped. Projects themselves are never touched. | Hidden while collapsed; only shown on hover otherwise (opacity fades in). |
| **Group empty drop target** `group-empty-<name>` | Not clickable: a dashed "Drag a project here" target shown when a group is open and has no projects in it. | Hidden once the group has at least one project, is folded, or a filter is active. |

### Project rows

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Project row** `sidebar-project-<name>` | Selects the project (`projects.select(item.id)`), which swaps the centre pane to its session and closes the Database MCP view if that was open. Also draggable (reorder, or drop into a group), a drop target for OS files (inserts `@path` into that project's composer), and right-clickable for the context menu. Keyboard-operable via Enter/Space. | Never fully unavailable, but not draggable while it is mid-rename. |
| **Project accent stroke** `project-accent-<name>` | Not clickable: a 2px edge rule down the row, green while the project has any live session (working, needs-you, error, or done-but-open), amber/idle otherwise. | Always rendered; its colour is the signal. |
| **Status badge** `status-badge-<name>` | Read-only: one glyph (`!` needs you, `»` working, `×` error, `·` ended, `—` done) summarising the most urgent state across all of that project's sessions. Hover/title gives the plain-language name. | Hidden when the project has never started a session (`status === 'none'`). |
| **Project pending badge** `project-badge-<name>` (appears twice — collapsed and expanded row layouts) | Read-only figure: pending inbox items for this project. | Hidden when that count is zero. |
| **Rename input** `rename-input-<name>` | Inline project rename; commits via `projects.rename` on Enter/blur, cancels on Escape. | Only present while that project is mid-rename. |
| **Timer** `timer-<name>` | Read-only: elapsed clock since the focused session started, ticking every second. | Hidden once the session has ended, or while the sidebar is collapsed. |
| **New session (row)** `new-session-<name>` (title: "Start another session in this project") | Calls `startAnotherSession`, which selects the project and starts an additional session in it (using the project's own default session mode), running alongside whatever is already active. | Hidden while collapsed; always enabled otherwise (a project can run any number of sessions). |
| **Remove project (row)** `remove-project-<name>` (title: "Remove this project") | Opens the remove-confirmation dialogue (`askRemove`). | Hidden while collapsed. |
| **Subsessions list** `sidebar-subsessions-<name>` | Not clickable: container shown only when a project is running more than one session, listing each as a row underneath the project. | Hidden when the project has one or zero live sessions, or while collapsed. |
| **Subsession row** `sidebar-subsession-<id>` | Selects the project and focuses that specific session in the centre pane (`focusSub`). Its title reports the session's status, name/branch, and id. | N/A — present whenever its parent subsessions list is shown. |
| **Agents container** `sidebar-agents-<name>` | Not clickable: lists the parallel subagents currently running under the selected, working project — but only when there is more than one (a lone agent is not worth a separate row). | Hidden for any project that is not the selected one, not currently "working", or running zero/one agent. |
| **Agent row** `sidebar-agent-<name>` | Calls `openAgent`, which selects that subagent's id so the centre pane shows its own chat rather than the main session's. | N/A — present only inside the agents container above. |
| **Agent-selected marker** `sidebar-agent-selected` | Read-only: an arrow icon shown next to whichever agent row is currently open. | Hidden unless that specific agent is the one selected. |

### Database MCP section

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **MCP server row** `mcp-server-<name>` | Calls `activeSession.openMcp(true)`, switching the centre pane to the combined Database MCP chat view (one shared session across every configured server). Title reports live connection status per server. | Hidden entirely unless at least one database MCP server is configured in settings. |

### Footer

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Settings row** `open-settings` (appears twice — expanded and collapsed layouts) | Emits `open-settings`, which `App.vue` handles by opening the Settings panel. Keyboard-operable via Enter/Space. | Always available. |
| **Model summary** `model-summary` | Read-only text: the current work model's short label (or "default model"), shown beside the Settings label. | Hidden while the sidebar is collapsed. |

### Right-click context menu

Opened on a project row or a group header; closes on outside click, Escape, or after any item fires.

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Context menu** `project-ctx-menu` | Not itself a control: the floating menu positioned at the click point. | Hidden unless a row/group was just right-clicked. |
| **Rename** `ctx-rename` | Starts inline rename for whichever project or group was right-clicked. | Always available in the menu. |
| **Move up** `ctx-move-up` | Moves the project (or group) one position earlier in its list, persisted via `projects.move` or `moveGroup`. | Effectively a no-op at the top of the list (silently ignored, not disabled). |
| **Move down** `ctx-move-down` | Moves the project (or group) one position later. | Effectively a no-op at the bottom of the list. |
| **New session here** `ctx-new-session` | Starts an additional session in the right-clicked project, same as the row's own + button. | Project-menu only; absent for a group's menu. |
| **End all N sessions** `ctx-end-all` | Ends every live session belonging to this project concurrently, tolerating individual failures, then refreshes the list. | Shown only when the project has more than one live session. |
| **Change folder…** `ctx-repoint` | Opens the change-folder dialogue for this project. | Project-menu only. |
| **New group with this** `ctx-new-group` | Creates a new group and immediately assigns the right-clicked project into it. | Project-menu only. |
| **Move to `<group>`** `ctx-move-to-<name>` (one per existing group) | Assigns the right-clicked project into that group. | Project-menu only; one entry per group that exists. |
| **Move out of group** `ctx-move-to-ungrouped` | Clears the project's group assignment, returning it to the Ungrouped tail. | Hidden unless the project currently belongs to a group. |
| **Remove from list** `ctx-remove` | Opens the remove-confirmation dialogue for this project (same dialogue as the row's remove button). | Project-menu only. |
| **Remove group (keeps projects)** `ctx-remove-group` | Deletes the group; its projects fall back to Ungrouped rather than being removed themselves. | Group-menu only. |

### Change-folder dialogue

Repoints a project at a different folder on disk. Sessions, history, and folder access move with it; the project keeps its existing name.

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Dialogue** `repoint-dialog` | The modal itself; traps Tab, closes on Escape or outside click. | Only open while a repoint is in progress. |
| **Path input** `repoint-input` | Free-text folder path, pre-filled with the project's current path. Enter submits. | N/A. |
| **Error text** `repoint-error` | Read-only: shown when the change fails — a friendly message if a session is still running ("Stop the session before changing the folder."), otherwise the raw error. | Hidden until a repoint attempt fails. |
| **Change folder (confirm)** `repoint-confirm` | Calls `projects.repoint`, which invokes IPC and does a full project refresh (a new path can change git status, drafts, and suggestions). | Disabled while a change is already in flight, or while the path field is empty. |
| **Cancel** `repoint-cancel` | Closes the dialogue without changes. | Always available. |

### Remove-project dialogue

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Dialogue** `remove-dialog` | The confirmation modal; traps Tab, closes on Escape or outside click. | Only open while a removal is being confirmed. |
| **Error text** `remove-error` | Read-only: shown if the removal fails, e.g. because a session is still live. | Hidden until an attempt fails. |
| **Delete** `remove-confirm` | Calls `projects.archive`, which invokes IPC to archive the project (its session and pending permissions are removed from Switchboard; files and git history on disk are untouched), then refreshes the list and clears selection if this was the selected project. | Disabled while the removal is already in flight. |
| **Keep it** `remove-cancel` | Closes the dialogue without removing anything. | Always available. |

**Notes worth having**: dragging a project row only ever reorders or joins a group — it never attaches a file reference, which is the opposite of dropping an OS file onto a row (that inserts `@path` into the project's composer). Removing a project is described in the UI as archiving in Switchboard only; it does not touch the developer's repository or git history at all.

## Status bar

A single-line instrument strip pinned under every pane, reporting board-wide figures rather than anything about the currently open project. Everything here is read-only — there is no interactive control in this file.

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Status bar** `statusbar` | Not a control: the bar itself, containing every reading below. | Always present. |
| **Running counter** `counter-running` / `counter-running-value` | Read-only figure: number of sessions currently running across all projects. | Always shown. |
| **Needs-you counter** `counter-needsyou` / `counter-needsyou-value` | Read-only figure: number of sessions waiting on the developer, shown in amber. | Always shown. |
| **Cost-today** `counter-cost` / `counter-cost-value` | Read-only figure: total spend today across all sessions, formatted as `$N.NN`. | Always shown. |
| **Token count** `usage-tokens` | Read-only figure: total tokens used today, compact-formatted (e.g. "1.2k tok"). | Always shown. |

**Note worth having**: the "⌃C interrupt" keyboard hint only appears when at least one session is actively "working" — it is genuinely conditional, since Ctrl+C only does anything mid-turn; the "send" hint is unconditional.

## Global spinner

A single floating indicator, bottom-right, that shows while any IPC call is in flight across the whole app. It has no click behaviour.

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Global spinner** `global-spinner` (aria: Loading) | Read-only: a small spinning ring. Appears only after IPC calls have been pending for 150ms (so a fast call never flashes it), and once shown stays for at least 350ms (so it never vanishes before it is noticed). | Hidden whenever no IPC call has been in flight long enough to cross the 150ms show-delay. |

## Session wait overlay

One shared full-window overlay used both when a session is starting and when one is being ended — the reasoning being that both are the same kind of interruption (a CLI process being spawned or drained, possibly a container being built or torn down) and deserve the same screen rather than two different treatments. It is a plain component with no click targets; its testids are supplied by the caller.

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Overlay** (testid supplied by caller, e.g. `session-start-overlay`) | Blocks the whole window behind a blurred scrim while a session start or stop is in progress; nothing underneath can be clicked until it clears. `App.vue` shows it with the title "Starting session…" whenever `projects.starting` is true. | Hidden once the in-flight start/stop finishes (successfully or not). |
| **Ring** (testid supplied by caller via `ringTestid`) | Read-only: the spinning progress ring inside the overlay. Stops animating (but stays visible, dimmed) under reduced-motion. | Present whenever its parent overlay is shown. |

**Note worth having**: this overlay used to differ between the start and end cases (a blurred scrim with a ring versus a bottom card with a sliding rule); they were deliberately unified so the same interruption reads as the same thing everywhere it happens. `SessionWaitOverlay` is also used from `SessionView.vue` for ending a session — that call site is outside this batch's files but shares this exact component and behaviour.

---

## Session view — header

The header identifies the project, shows session status at a glance through a row of status pills, and holds the two controls that act on a running session directly (interrupt, end). A second, quieter row underneath carries session metadata (branch, model, mode, diff stats, cache, usage, run id).

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Project name** `session-project-name` | Shows the project's display name. Truncates with an ellipsis before the path gives way, so a long solution-folder name is protected first. | Never hidden; always shown. |
| **Project path** `session-project-path` | Shows the project's folder path. Shrinks first when the row runs out of width. | Never hidden. |
| **Bypass pill** `bypass-pill` | Reads "Bypass" with a warning glyph; its title states the session was started with `--dangerously-skip-permissions`. Display only. | Hidden unless the live session was started in bypass mode. |
| **Plan-mode toggle** `plan-mode-toggle` | A pill that both shows and sets planning state. Reads "Planning" (amber) when the session is read-only pending an approved plan, or "Plan" when not. Clicking calls `active.setPlanMode`, which sends `sessions.setPlanMode` to main; the pill only updates once the CLI reports the mode back, so it never claims a state that has not actually taken effect. Applies from the session's next tool call, not instantly. | Hidden on a bypass session, which approves everything and so has nothing to plan against. |
| **No-git pill** `nogit-pill` | Reads "No git"; its title carries the project's git notice (the container mounts only the project folder, so git only works if `.git` sits at its root). Display only. | Hidden unless the live session is a bypass session AND the project has a git notice. |
| **Fan-out pill** `fanout-pill` | Reads "Fan-out"; states the session was started with Heavy subagents on, and that toggling the setting now only applies to the next session. Display only. | Hidden unless the live session has `heavySubagents` set. |
| **Agents pill** `agents-pill` | Reads "N agents" — a count of subagents currently working this turn. Display only. | Hidden unless more than one agent is working. |
| **Background pill** `bg-pill` | Reads "N background" — a count of background tasks (deep-research workflows, backgrounded subagents/bash) still running. Display only. | Hidden unless at least one background task is running. |
| **Session status pill** `session-pill` | Shows the live session's status: Working, Needs you, Done, or Error. Display only. | Hidden once the session has ended (replaced by a plain "Ended" pill with no test id of its own). |
| **Interrupt turn** `stop-session` | Stops the current turn only — same effect as Ctrl+C in the composer — leaving the session open. Calls `active.interrupt()` → `sessions.interrupt`. A red square, deliberately unlabelled beyond its title/aria-label, since the composer's Ctrl+C behaviour and the status bar already name the binding. | Hidden whenever the live session is not in the `working` status. |
| **End session** `end-session` | Ends the session outright (distinct from interrupt): calls `active.stop()` → `sessions.stop`. Resumable later. Label switches to "Ending" and a wait overlay (`ending-overlay`/`ending-bar`) covers the pane until the session row confirms it has ended — this can take a few seconds because the SDK has to drain and, for a containerised session, the container has to tear down. | Disabled while this project's own end-in-progress flag is set (prevents a second click mid-teardown). Hidden entirely once there is no live session. |
| **View toggle** `view-toggle` (tablist), with **Clean** `view-clean` and **Raw** `view-raw` | Switches the stream between the grouped/narrated Clean view and the complete mono Raw log. Calls `switchView`, which also re-pins the scroll position to the newest line, because Clean and Raw are separate scroll containers. | Always available; whichever tab is active is marked with `aria-selected`. |
| **Model label** `session-model` | Shows the model currently answering in this session (from turn usage figures). Display only. | Hidden until a model label is known. |
| **Mode chip** `session-mode` | Shows "Advisor" or "Orchestrator" with an icon; the title explains the distinction (cheap-model-with-strong-consult vs. strong-planner-with-cheap-workers). Display only. | Hidden unless the live session reports a `currentMode`. |
| **Diff stats** `diff-stats` | Shows the working tree's added/removed line counts (+N in green, −N in red) for the live session. Display only. | Hidden until the session has completed at least one turn and reports `diffAdds`. |
| **Cache rate** `session-cache` | Shows the prompt-cache hit percentage for the latest turn; the title explains it is cached-prefix reuse vs. re-billed tokens. Display only. | Hidden until a cache figure is available. |
| **Usage widget** `session-model-usage` | Shows total tokens, cost, and a per-model breakdown for the session. Clicking calls `openFullUsage()`, which switches to the Session tab and sends the literal message `/usage` into the conversation — the full picture is the CLI's own `/usage` output, not a separate view. | Hidden until there is any session usage to show. |
| **Run id** `session-stamp` | Shows the session id's first eight characters; the full id sits on the title attribute. Display only. | Hidden until a session id (live or ended) exists. |

## Drop overlay

Shown while something is being dragged over the pane, naming what will happen on release.

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Drop overlay** `drop-overlay` | A dashed-frame prompt reading either "Reference this project" (dragging a project from the sidebar) or "Reference file path" (dragging a file), with matching sub-text. Purely informational; the actual drop is handled by the pane's own drag handlers, not by this element. | Hidden whenever nothing is being dragged over the view. |

## Main tab strip

Chooses which part of the project the main area shows: the live conversation, or one of five supporting sections. Each keeps its own state; switching tabs never ends the session.

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Session** `tab-session` | Shows the live/ended conversation stream (Clean or Raw). | Always available. |
| **Specs** `tab-specs` | Shows this project's Spec Kit specs (`SpecsView`); a badge shows the current spec count. | Always available. |
| **Tests** `tab-tests` | Shows the verification section (`TestsView`) for the current branch. | Always available. |
| **Diff** `tab-diff` | Shows the working-tree diff (`DiffView`); a badge shows how many files changed. Opening this tab (or the diff stats changing while it's open) triggers a fresh `diff.loadList` — each refresh costs two git processes, so it is deliberately not run continuously in the background. | Always available. |
| **Cleanup** `tab-cleanup` | Shows suggested review/cleanup commands (`CleanupView`) for launching against this project. | Always available. |
| **Diagrams** `tab-diagrams` | Shows the diagram generator/browser (`DiagramsView`) for this project. | Always available. |

## Conversation stream (Clean view)

The default view of a session: a narrated, grouped rendering of events, with the agent-chat banner, the ended-session start controls, the live status line, and the agents/background-task panels layered in as relevant.

### Agent chat sub-view

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Agent banner** `agent-banner` | A strip naming the subagent whose chat is currently open, with a "subagent" chip. Purely a header for the scoped view below it. | Hidden unless a subagent's chat is selected. |
| **Back to project** `agent-back` | Calls `active.selectAgent(null)`, returning from a subagent's isolated chat to the main project stream. | Hidden unless a subagent's chat is open. |

### Empty / ended states

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **No-session hint** `no-session-hint` | States there is no session yet and points at "+ in the sidebar" to start one. Display only. | Hidden once a session (live or ended) exists for the project. |
| **Ended banner** `ended-banner` | States the session ended, with its end reason and any status detail. Container for the restart controls below. | Hidden while a session is live. |
| **Mode picker** `start-mode-picker` | Opens/closes the dropdown of session modes (`modeOpen`) for the *next* session start. Shows the currently chosen mode and its detail as a title. Opens on whatever mode the previous session actually started in (not where it ended up — a session toggled out of plan mode mid-flight still counts as having started in Plan). | Disabled while a start is in progress (`busy`). Hidden while a session is live. |
| **Mode list** `start-mode-list`, each option `start-mode-${value}` | Lists the modes currently offered and picks one on click, closing the dropdown. When Resume is on, only the modes compatible with the ended session's own bypass/non-bypass state are offered — resuming looks for the previous transcript in the matching location (host `~/.claude` vs. the project's container volume) and mixing them silently finds nothing. | The dropdown itself only renders while open; the list is filtered live by the Resume switch. |
| **Resume session** `resume-session` | A switch: when on, the next start carries the ended session's conversation forward instead of beginning empty. Toggling it can narrow the mode list (see above) and moves the picked mode off an incompatible choice automatically. | Disabled when there is nothing to resume — the ended session never reached the point of having an `sdkSessionId` to resume from. |
| **Run in container** `run-in-container` | A switch: when on, the next session runs inside a Linux container with only the project folder mounted, rather than directly on the host. | Disabled (and shown permanently on) whenever the chosen mode is Bypass — bypass sessions are always containerised, since on Windows that is the only isolation left between "approve everything" and the rest of the disk. |
| **Start session** `start-session` | Starts the next session for this project: calls `projects.startSession` with the chosen mode, the Resume flag, and the container flag. Label reads "Resume" when resuming, else "Start session". A failed start (e.g. Docker not running for a bypass session) is caught and shown in the ended banner rather than surfacing as a silent rejection; the view also watches the newly created session row for an immediate crash (a start that spawns successfully but dies right away, most often an invalid resume) and reports that the same way. | Disabled while a start is already in progress. |
| **Bypass warning** `bypass-warning` | States plainly that nothing will ask for approval in bypass mode and it should only be used in throwaway or fully trusted folders. Display only. | Hidden unless Bypass is the currently selected start mode. |
| **Start error** `start-error` | Shows the reason the last start attempt failed. Display only. | Hidden while there is no start error recorded. |

### Live activity

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Inline question** `inline-question` | Renders a plain-text question (Spec Kit's `/speckit-clarify` idiom) as clickable option chips plus a free-text field, via the shared `QuestionEvent` component. Answering sends the chosen text as a normal message (to the open subagent's chat if one is selected) and retires the card locally so a double-click cannot send twice. | Shown only when the session is not currently working AND the latest assistant message parses as such a question that has not already been answered by a newer prompt. |
| **Live line** `live-line` (agent view) | A blinking marker showing the open subagent's current task/label. | Shown only inside an agent's chat view. |
| **Agent list** `agent-list`, header **Agents toggle** `agents-toggle`, rows **Agent row** `agent-row`, overflow **Agents more** `agents-more` | Replaces the single live line when more than one subagent is working in parallel: lists up to six agent rows (name + task), each clickable to open that agent's own chat (`active.selectAgent`). The toggle expands to show every agent; the "N more" row does the same on click. | The panel itself only appears with more than one agent working; the toggle/overflow row only appear once the list exceeds six. |
| **Live line — working** `live-line` (session view) | A blinking marker showing the session's current status detail, or "Working…". Marked `role="status"` so a screen reader announces it. | Shown only when exactly one/no subagent view is open AND the live session's status is `working`. |
| **Live line — needs you** `live-line` (blocked) | A blinking, `role="alert"` marker reading "Blocked — N pending" or "Blocked — needs your answer". | Shown only when the live session's status is `needs_you`. |
| **Background task list** `bg-task-list`, header **toggle** `bg-task-toggle`, rows **row** `bg-task-row`, overflow **more** `bg-task-more` | Shows still-running background tasks (deep-research workflows, backgrounded subagent/bash work) independently of the live-line state above, so it can appear alongside any status. Same six-row cap and expand/collapse behaviour as the agent list; rows are display-only (no click handler — background tasks have no chat view to open). | The panel is hidden whenever there are no background tasks; the toggle/overflow only appear past six tasks. |
| **Show earlier activity** *(no distinct id — part of the stream; see `load-earlier` class)* | Widens how much history is rendered: first pages back within what is already loaded in memory, then within the store's own window, and only then asks main for older events from SQLite. | Hidden once the stream is already showing everything that exists for the session. |

## Raw view

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Stream/raw container** `stream` | The scrolling container for whichever view is active — Clean (shares the same test id as the raw container) or the Raw log. Both are covered under the one `stream` id since only one renders at a time. | Not applicable — always one or the other. |
| **Raw line** `raw-line` | One formatted line of the complete session log, in monospace. Display only. | Rendered per line; none appear if the session has produced no output yet. |
| **Raw stamp** `raw-stamp` | A timestamp prefix on a raw line. Display only. | Hidden unless the "Show timestamps" output setting is on. |

## Composer footer

The message input and everything anchored to it: the jump-to-latest button, the REFS row, the UP NEXT queue, the Ctrl+C stop-confirmation, and the send/queue controls themselves.

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Jump to newest line** `scroll-to-bottom` | Scrolls the stream to its latest line. Anchored to the composer's top edge (not the stream) so it stays in the stream's bottom-right corner regardless of composer height. | Hidden whenever the stream is already scrolled to (or near) the bottom. |
| **REFS row** `refs-row` | Lists the folders/projects this session may additionally read, as removable chips, and the pane's own drop target for adding more by drag-and-drop. | Always shown, even with zero refs (only the chips vary). |
| **Ref chip** `ref-chip-${label}` / **Remove ref** `ref-remove-${label}` | Shows one reference's label (full path on hover); the × button calls `removeRef`, revoking that folder's read access for the session. | One chip per current ref; nothing to remove once the list is empty. |
| **Ref input** `ref-input` | A text field for typing a folder path or project name to add as a reference; Enter commits it (`commitRef`), Escape or blur cancels. | Shown only after clicking "+ reference"; hidden otherwise. |
| **Add reference** `ref-add` | Opens the ref input. Title also notes a project can be dragged from the sidebar onto the view instead. | Hidden while the ref input is already open. |
| **Ref error** `ref-error` | Shows why a just-typed reference could not be added. Display only. | Hidden while there is no ref error. |
| **Task queue (UP NEXT)** `task-queue` | Lists planned messages queued to run automatically once the current goal finishes. | Hidden while the project has no queued tasks. |
| **Queue item** `queue-item-${index}` | One queued task's row: its position number plus its text or edit field. | Rendered per queued item. |
| **Queue edit field** `queue-edit-${index}` | An in-place editor for a queued task's text. Enter saves (`saveQueued`), Escape cancels, and losing focus also saves — the edit is one line, so a modal would be heavier than the change itself. | Shown only for the item currently being edited. |
| **Queue text (click to edit)** `queue-text-${index}` | Shows the queued task's text; clicking begins editing it (`beginEditQueued`). | Shown for every item not currently mid-edit. |
| **Remove queued task** `queue-remove-${index}` | Removes the task from the queue via `removeQueued`. | Available on every queued item. |
| **Queued-edit error** `queued-edit-error` | States that a queued message could not be changed — surprising case: the turn can finish and deliver the message while the edit dialog is still open, and the app says so rather than pretending the edit succeeded. | Hidden while there is no such error. |
| **Draft-restored note** `draft-note` | States a previous run's unsent draft was restored into the composer, and invites sending it. Tracks the *exact* restored text, so any edit at all — not just clearing the box — retires the note, since it is a claim about that specific text. | Hidden once the composer no longer holds exactly the restored text (or none was restored). |
| **Stop confirmation** `stop-confirm`, **Stop** `stop-confirm-yes`, **Cancel** `stop-confirm-no` | A confirm strip shown after the first Ctrl+C while the composer is focused and the session is working. "Stop" interrupts the turn (`confirmStop` → `active.interrupt()`); "Cancel" (or Escape, or a second Ctrl+C, or letting 4 seconds pass) dismisses it. This is the only interrupt affordance in the UI — there is no separate interrupt button beside the composer, only the header's `stop-session` control and this Ctrl+C flow. | Hidden until Ctrl+C is pressed with the composer focused and no text selected, on a working session; auto-dismisses after 4 seconds. |
| **Composer target chip** `composer-target` / **Clear target** `composer-target-clear` | Shows which spec file the composer will rewrite when a Spec-view "Refine" action has set an edit target; clearing it returns the composer to sending normal chat messages. | Hidden unless a spec-edit target is currently set. |
| **Suggestion list** `suggest-list`, items `suggest-item-${index}` | A dropdown of matching slash-commands/skills/history as the composer is typed into; clicking an item accepts it (`acceptSuggestion`) into the composer. | Hidden whenever there are no matching suggestions. |
| **Ghost completion** `ghost-suggestion` | The greyed-out remainder of a matched command shown behind the caret, for Tab/→-style completion. Display only. | Empty string when nothing is being completed. |
| **Composer input** `composer-input` | The message textarea. Typing drives suggestions and the ghost text; Enter (via the shared keydown handler) submits. Sending goes through `send()`: if a spec-edit target is set it rewrites that spec via `specs.runInSession`; otherwise it is appended with any REFS as `@path` mentions and sent to the live session (or, if a subagent's chat is open, prefixed `[to <agent>]` and routed to that agent — the SDK has no separate subagent input channel, so the main loop relays it). | Disabled when there is no live session AND no spec-edit target set. |
| **Send-to label** `composer-to` | States who the next message goes to — the open subagent's task/name, or the project name. Display only. | Always shown. |
| **Queue** `composer-queue` | Adds the composer's text to the UP NEXT queue instead of sending it now (`enqueue()` → `queue.add`), then clears the composer. | Hidden while a spec-edit target is set (queuing doesn't apply to spec edits). Disabled while the composer is empty. |
| **Send** `composer-send` | Sends the composer's text now, via `send()` as described above. | Disabled when there is no live session and no edit target, or a send is already in flight (`busy`), or the composer is empty. |

---

## Settings dialogue

The Settings dialogue is a modal opened over the app, with a left icon rail of six tabs and a scrollable content pane on the right. It is where a developer sets which models run sessions, overrides those models for one project, chooses which MCP servers appear together in chat, manages standing auto-approve rules, adjusts how the terminal view looks and behaves, and checks for app updates. Escape closes it and focus returns to whatever opened it; clicking the dimmed overlay outside the card does the same, though the overlay itself carries no test id.

### Header and tab rail

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Settings dialogue** `settings-panel` | The dialogue's root panel. Holds the tab rail on the left and the active tab's content on the right. | Not rendered unless something else in the app has opened Settings. |
| **Close** `settings-close` | Closes the dialogue immediately, discarding nothing (every change on every tab is already saved as it is made). | Never disabled. |
| **Tab** `` `settings-tab-${t.id}` `` | One button per tab (Models, This project, MCP, Allowed list, Terminals, General). Clicking switches the content pane to that tab; the previously open tab's state is not lost, it is just not shown. | Never disabled. All six render even though the panel is normally opened onto Models, This project, Terminals or General; MCP is reachable only by clicking here. |

### Models tab

Sets the two models every session uses (a strong "intelligent" model and a cheap "worker" model) and how they are paired on a turn. These are global defaults; a project can override them on the "This project" tab.

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Mode card** `` `mode-${m.id}` `` | One of three cards: Auto, Advisor, Orchestrator. Selecting one saves `modelMode` immediately (`store.save` calls the `settings.set` IPC method, which persists the value and returns the saved settings). Auto lets each message pick the pattern; Advisor runs the whole session on the worker model with the intelligent model consulted rarely; Orchestrator runs the whole session on the intelligent model and delegates scoped chunks to worker subagents. | Never disabled. Takes effect immediately for new sessions; a session already running keeps its current model pairing until its next turn, because switching a session's main model mid-flight discards its prompt cache. |
| **Intelligent/Worker model card** `` `${section.testid}-${m.id}` `` | Two card lists (INTELLIGENT MODEL, WORKER MODEL) built from the models the account's subscription can select, plus a "Follows your subscription default" option. Clicking a card saves `intelligentModel` or `workerModel`. | Never disabled. The card list is empty of real models (falls back to the account default only) if the CLI could not report available models yet. |
| **Pair models by message** `setting-auto-routing` | Toggles `autoModelRouting`. On, each message is read and routed to the advisor or worker-delegation pattern that suits it; off, the Mode card above is followed literally. | Never disabled. |

### This project tab

Overrides that apply to one project only, chosen from a dropdown at the top of the tab.

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Project picker** `proj-settings-picker` | Opens or closes a dropdown listing every project, so the tab's settings below can target a project other than the one currently selected in the sidebar. | Never disabled, but the whole tab shows "No projects yet" instead of this control when there are no projects to configure. |
| **Project option** `` `proj-settings-option-${p.id}` `` | Picks that project as the one this tab configures and closes the dropdown. | Never disabled. |
| **Session type group** `proj-session-mode` | The row of session-type cards described below; shown as a group so the five options read as one choice. | Not shown when no project is selected. |
| **Session type card** `` `proj-session-mode-${m.value}` `` | One of the five permission modes (Default, Don't ask, Auto, Accept edits, Bypass). Selecting one calls `projects.setSessionMode`, which persists the mode on the project record. It applies to the project's *next* session, not one already running. Bypass is marked with a warning icon because nothing in that mode asks for approval. | Never disabled. |
| **Model override card, "Use global default"** `` `${section.testid}-global` `` | Clears this project's override for the Intelligent or Worker model, so it falls back to whatever the Models tab has set. | Never disabled. |
| **Model override card** `` `${section.testid}-${m.id}` `` | Sets a per-project override for the Intelligent or Worker model, stored in `projectModels` / `projectWorkerModels` keyed by project id, leaving the global default untouched for every other project. | Never disabled. |

### MCP tab

Chooses which reported MCP servers are combined into a single view and chat, rather than every session exposing every server individually.

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **MCP server options** `db-mcp-options` | The list of card buttons below, one per MCP server name seen from any live session (plus any name already designated, so a server stays visible even if no session currently reports it). Shows a note instead when the list is empty. | Shown even with zero entries; the note beneath explains why. |
| **MCP server card** `` `db-mcp-${name}` `` | Ticks or unticks that server into the "database MCP" combination. Ticking a server also switches it on in the active chat combination (`mcpActiveServers`); unticking removes it from both. Saved immediately via `settings.set`. | Never disabled. |
| **Server name input** `db-mcp-input` | Free-text entry for a server name not yet reported by any session (e.g. `postgres`). Pressing Enter adds it the same way as the Add button. | Never disabled. |
| **Add** `db-mcp-set` | Adds the typed server name to the combination (equivalent to ticking a card for it), then clears the input. Does nothing if the field is empty or the name is already selected. | Never disabled, but a no-op on an empty or duplicate name. |

### Allowed list tab

Controls automatic approval: by risk level globally, and by specific command pattern per project.

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Low risk** `setting-auto-low` | Toggles `autoApproveLow`. On, read-only actions (file reads, git status, listings) are approved automatically and logged as rule-approved rather than reaching the inbox. | Never disabled. |
| **Medium risk** `setting-auto-medium` | Toggles `autoApproveMedium`. On, routine changes (file edits, package installs, builds) are approved automatically. High risk is never auto-approved by either toggle. | Never disabled. |
| **Allowed commands list** `allowed-rules` | Shows every standing rule for the currently selected project, loaded from `inbox.listStandingRules`. Includes a fixed, non-interactive row noting that destructive commands (`rm`, `sudo`, `git push`) can never be auto-approved. | Empty until a project is selected; the surrounding text then reads "this project" instead of a name. |
| **Ask** `` `rule-ask-${r.id}` `` | Revokes that rule (`inbox.revokeStandingRule`), so the matching command goes back to asking in the inbox. Revoked rules stay listed rather than disappearing, so what was once allowed remains visible. | Never disabled; already-revoked rules simply show Ask as the active state. |
| **Auto** `` `rule-auto-${r.id}` `` | Restores a revoked rule (`inbox.restoreStandingRule`), so the matching command is approved automatically again. | Never disabled; already-active rules show Auto as the active state. |
| **New command input** `allowed-add-input` | Free-text field for a command pattern to allow (e.g. `make build`). Pressing Enter adds it the same way as the Allow button. | Never disabled. |
| **Allow** `allowed-add-btn` | Creates a new standing rule for the pattern typed (`inbox.addStandingRule`) and clears the field. Does nothing on an empty pattern or with no project selected. | Never disabled, but a no-op without a project or without text. |

### Terminals tab

How a session's output looks and behaves, plus the Docker memory cap for bypass sessions.

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Font size** `` `setting-font-${v}` `` | Three-way segmented control (Small, Medium, Large) setting `fontSize`, which changes the text size in both the Clean and Raw output views. | Never disabled. |
| **Default view: Clean** `setting-view-clean` | Sets `defaultView` to `clean`, so a session opens showing summarised turns rather than the raw terminal stream. | Never disabled. |
| **Default view: Raw** `setting-view-raw` | Sets `defaultView` to `raw`, so a session opens showing the unabridged terminal stream. | Never disabled. |
| **Show tool activity in Clean view** `setting-tool-rows` | Toggles `showToolRows`. On, commands and tool calls in Clean view collapse into an expandable "worked quietly" row instead of being hidden entirely. Raw view always shows everything regardless of this setting. | Never disabled. |
| **Timestamps** `setting-timestamps` | Toggles `timestamps`, showing or hiding the time next to every event in Clean view. | Never disabled. |
| **Follow output** `setting-autoscroll` | Toggles `autoscroll`. On, the view stays pinned to the newest line as Claude works. | Never disabled. |
| **Turn summaries** `setting-summaries` | Toggles `summaries`. On, a turn's closing message is styled as a SUMMARY line; off, the raw response is shown as-is (for example, the full `/usage` report). Display-only, it triggers no extra model call. | Never disabled. |
| **Terse mode** `setting-terse-mode` | Toggles `terseMode`. On, Claude's replies (output tokens only) are compressed to save cost and time; prompts, context, code, commands and errors are unaffected. Revealing this toggle also reveals the Terse level cards below it. | Never disabled. |
| **Heavy subagents** `setting-heavy-subagents` | Toggles `heavySubagents`. On, a session is instructed to split work into independent parts and dispatch them to subagents in one batch rather than working a list on one thread, and it pins the session to the Orchestrator protocol (Advisor's own instruction to do scoped work directly cannot coexist with it). Read only when a session starts, so it applies from the next session, not one already running; a session shaped by it shows a Fan-out pill in its header. | Never disabled. |
| **Terse level** `` `terse-level-${level}` `` | Three cards (lite, full, ultra) setting `terseLevel`, controlling how aggressively replies are compressed. | Hidden entirely unless Terse mode is on. |
| **Sandbox memory** `setting-sandbox-memory` | Free-text field for the Docker memory cap applied to bypass sessions (e.g. `6g`, `12g`, or `0` for no cap). Saves on Enter or on blur, not per keystroke, so a size half-typed on the way to "12g" is never persisted. Applies from the next bypass session, not one already running. | Never disabled; an empty or unchanged value is simply not saved. |

### General tab

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Desktop notifications** `setting-notifications` | Toggles `notificationsEnabled`. On, a desktop notification pops when a session needs approval, hits an error, or finishes, and it can be approved directly from the notification. | Never disabled. |
| **Update status** `update-status` | Read-only line reporting the current update state: checking, an available version, download progress as a percentage, ready-to-restart, up to date, or an error message. | Always shown; its text is simply "Updates are delivered from GitHub releases" before a check has ever run. |
| **Check for updates** `update-check` | Calls `updates.check`, which asks GitHub releases for a newer version and updates the status line above. | Disabled while a check is already in progress (`updates.busy`, i.e. state is "checking"). |
| **Download update** `update-install` | Calls `updates.install`, which downloads the update inside the app and restarts into the installer, falling back to opening the release page if the feed or download cannot be used. | Hidden entirely unless the status is "available" (a newer version has been found but not yet downloaded). |

### Footer

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Done** `settings-done` | Closes the dialogue. Identical to Settings-close; present because every change on every tab is already saved as it is made, so there is nothing left for this button to commit. | Never disabled. |

## New session dialogue

`ProjectRegistration.vue` is the "New session" modal: point it at a folder and that folder is registered as a project and shown in the sidebar, with a session started in it immediately. Escape closes it, as does clicking the dimmed overlay outside the card.

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **New session dialogue** `registration-dialog` | The dialogue's root panel: header, scrollable body (folder field, access summary, session type), and a pinned footer with Start/Cancel. | Not rendered unless something else in the app has opened it. |
| **Error message** `registration-error` | Read-only line reporting why starting failed: the folder does not exist, the folder is already registered under a different path than the one typed, a Docker-backed bypass session could not start, or another error's raw message. | Shown only after a failed attempt to start; empty otherwise. |
| **Folder path** `folder-input` | Free-text field for the project folder (e.g. `~/dev/my-project`). Pressing Enter starts the session, the same as clicking Start session. Typing here also updates the "Session name" preview live. | Never disabled. |
| **Browse…** `browse-folder` | Opens the native OS folder picker (`dialog.pickFolder`) and, if a folder is chosen, writes its path into the Folder field above. Cancelling the picker changes nothing. | Disabled while a session is in the process of starting. |
| **Session name preview** `session-name-preview` | Read-only line showing the last path segment of the typed folder, which is the name the project will be registered under. Shows an em-dash placeholder while the field is empty. | Always shown; reduces to the placeholder when there is nothing typed. |
| **Session type** `` `session-mode-${m.value}` `` | A native radio group of five permission modes (Default, Don't ask, Auto, Accept edits, Bypass) plus "Plan first" is also offered as a sixth in the shared list, one control expressing exactly one SDK setting. Choosing one sets this new project's `defaultSessionMode`, which every session it starts afterwards follows until changed later in Settings. Bypass is marked as the dangerous option (its selected dot renders in red rather than green). | Never disabled. |
| **Bypass warning** `bypass-warning` | A warning banner reading that nothing will ask for approval and the mode should only be used in throwaway or fully trusted folders. | Shown only while Bypass is the selected session type. |
| **Start session** `start-session` | Registers the folder as a project (`projects.register`, carrying the chosen session type), selects it, and starts a session in it (`sessions.start`), then closes the dialogue. If the folder is already registered, it instead selects the existing project, applies the chosen mode to it if different, and starts a session only if none is currently running there, all without closing early on that path's own errors. | Disabled while a start is already in progress, or while the folder field is empty or only whitespace. |
| **Cancel** `registration-cancel` | Closes the dialogue without registering anything or starting a session. | Never disabled. |

---

## Inbox

The Inbox is the panel where every session's permission requests land, grouped by project, so approvals do not require switching to the session that asked. It has two tabs: pending items awaiting a decision, and a history of decisions already made. It refreshes on mount and reacts live to permission events pushed from the main process.

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **The panel itself** `inbox-view` | The right-hand rail. Holds every pending request across every project, not just the one on screen — that is the point of it: you answer from wherever you are. Resizable by dragging its left edge (280–680px) and collapsible; the width persists across launches. | Hidden only while the rail is collapsed, which leaves a badge in the top right that reopens it. |

### Tabs and header

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Inbox tab** `inbox-tab-pending` | Switches to the pending-items list. | Never disabled; shown selected while active. |
| **Pending count badge** `inbox-badge` | Shows the number of items awaiting a decision, on the Inbox tab. | Hidden when the pending count is zero. |
| **History tab** `inbox-tab-history` | Switches to the decisions-history list; on first switch to this tab it reloads history from the store (`inbox.loadHistory`) and refreshes which Bash command prefixes are already covered by a standing rule. | Never disabled. |
| **Collapse** `inbox-collapse` | Emits `collapse` to the parent (`App.vue`), which folds the inbox pane down to the peek rail. | Never disabled. |
| **Undeliverable notice** `undeliverable-notice` | A banner that appears when a decision (approve/deny) could not reach its originating session because the session had already ended; the request was marked expired instead. | Hidden once dismissed or when no delivery has failed. |
| **Dismiss notice** `notice-dismiss` | Clears the undeliverable-decision banner. | Never disabled while the banner is shown. |
| **Inbox zero** `inbox-zero` | Empty-state message shown when there are no pending items in any project. | Hidden once at least one item is pending. |

### Pending items

Pending items are grouped per project. Each group can be approved in one action; each item can be approved, denied, or turned into a standing rule that auto-approves similar requests in future.

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Project group** `inbox-group-<project>` | Shows one project's pending items with a live-updating count. | Hidden when that project has no pending items. |
| **Approve all** `approve-all` | Approves every pending item in the group in one call (`inbox.approveAllForProject`). If the group contains no high-risk items it approves immediately; otherwise it first arms a one-step confirm (see below). | Hidden when the group has only one item (a single item is approved on its own card instead). |
| **Approve-all warning** `approve-all-warn` | Text shown once "Approve all" is clicked on a group with high-risk items, stating how many of them are high-risk. | Shown only mid-confirm. |
| **Approve-all confirm** `approve-all-confirm` | Confirms the bulk approval, sweeping in the high-risk items too. | Shown only once the warning has appeared. |
| **Approve-all cancel** `approve-all-cancel` | Backs out of the bulk-approve confirm without approving anything. | Shown only mid-confirm. |
| **Item card** `inbox-item` | One pending request: title, tool name (where it adds information over the title), age, and a risk chip. | n/a — one card per pending item. |
| **Item title** `item-title` | The human-readable description of what is being asked. | n/a. |
| **Risk chip** `item-risk` | Shows "Plan" for a plan-approval request, or Low/Medium/High for a tool permission, coloured by risk. | n/a. |
| **Why toggle** `item-explain-toggle` | Expands or collapses a short explanation of why the item was classified at its risk level. | Never disabled; closed by default. |
| **Item detail** `item-detail` | The full command, file path, or JSON payload behind the request. | Hidden when the title already states the same thing verbatim (this happens for most Bash requests, so many cards intentionally show no separate detail box). |
| **Approve** `approve-btn` | Approves the item (`inbox.decide` with `approve`). For a high-risk tool permission the first click arms a "Confirm high-risk" / "Back" pair instead of approving immediately — a second click is required. | Never disabled. |
| **Deny** `deny-btn` | Denies the item (`inbox.decide` with `deny`) and sends the session on to its next step without running the tool. | Never disabled. |
| **Confirm high-risk** `confirm-high-risk` | The armed second step of Approve for a high-risk item; actually approves it. | Shown only after the first Approve click on a high-risk item. |
| **Always allow (standing rule)** `always-allow-btn` | Creates a standing rule that auto-approves similar requests in this project from now on, then approves this one (`inbox.approveAlways`). For an MCP tool this always-allows every call to that tool; for Bash it always-allows the command's two-token prefix. | Hidden for non-MCP tools other than Bash, for high-risk Bash items, for commands already classified dangerous, and for any command a standing rule already covers. |
| **Confirm always-allow** `confirm-always-allow` | The armed second step of the broad MCP "always allow" grant when the item is high-risk (a broad grant must not skip the high-risk confirm). | Shown only after the first click of Always-allow on a high-risk MCP item. |

Surprise worth noting: the confirm-high-risk state and the confirm-always-allow state are tracked separately, so arming one never silently arms or cancels the other — clicking Approve then Always-allow does not carry over a pending confirmation from the first.

### History

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Decision count** `history-count` | Shows how many past decisions are recorded. | n/a. |
| **Clear history** `history-clear` | Deletes every recorded decision (`inbox.clearHistory`); does not affect standing rules already created. | Hidden when history is empty. |
| **History row** `history-item` | One past decision: title, project, command/detail, and how long ago it resolved. Clicking, Enter, or Space expands it in place; right-click, the keyboard Menu key, or Shift+F10 opens the context menu instead. | n/a — one row per history entry. |
| **Outcome mark** `outcome-<status>` | A check or cross icon showing whether the decision was an approval (including rule-approved) or a denial/expiry. | n/a. |
| **Delivery-failed marker** `delivery-failed` | Appended to a row's subtitle when that decision could not be delivered to its session. | Hidden when delivery succeeded. |
| **History detail** `history-detail` | Expanded view of the row: the recorded explanation, plus the full command/detail (again omitted when it only repeats the title). | Shown only while the row is expanded. |
| **Context menu** `hist-ctx-menu` | Right-click/keyboard menu for a history row, showing the command and two actions. | Shown only after opening it on a row. |
| **Always allow (from history)** `hist-ctx-allow` | Creates a standing rule for the command's prefix from a past decision (`inbox.alwaysAllow`), without re-approving anything (the decision already happened). | Hidden when the entry is not an eligible Bash command, is classed dangerous, or a rule already covers its prefix. |
| **Remove this entry** `hist-ctx-remove` | Deletes just this one history record (`inbox.deleteHistory`). | Never disabled once the menu is open. |

## Session stream pieces

These components render the individual rows of a session's clean-view transcript: what the assistant said, what a tool did, permission markers, questions, errors, and quiet stretches of tool noise.

### StreamEvent

One row in the clean-view stream. Its shape depends entirely on the event's kind; most sub-parts carry no independent control, only a `data-testid` naming which kind is showing.

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Permission marker** `permission-marker` | A one-line row standing in for a request that went to the inbox, so the transcript records that the agent stopped and asked rather than appearing to skip it. Carries a status chip (pending, approved, denied, expired) and the request's title. | Shown only for `permission_marker` events. |
| **Plan marker** `plan-marker` | The same row for a plan approval. While pending, its chip reads "Plan approval" rather than the generic status word, because a plan is a different kind of answer from a tool permission. | Shown only for `plan_marker` events. |
| **Review in inbox** (inside either marker) | Jumps to the inbox and focuses the item the row stands for, so a marker noticed while reading the transcript does not mean hunting for it in the rail. | Shown only while the marker is still pending. |
| **Event row** `stream-event-<kind>` | The whole rendered row for one session event (prompt, assistant text, summary card, tool line, marker, error, or result). | Hidden entirely when the event carries no visible content (an empty streamed text block, for instance). |
| **Timestamp** `event-stamp` | An HH:MM stamp to the left of the row. | Hidden unless the Timestamps setting is on. |
| **Prompt edit field** `prompt-edit` | A textarea for rewording a message that is still queued (not yet sent to the session). Enter or losing focus saves the edit (`edit-queued`); Escape abandons it; saving an empty value withdraws the message instead of sending it. | Shown only while actively editing; a prompt that has already been sent is never editable. |
| **Editable prompt text** `prompt-editable` | Click to open the edit field, prefilled with the current queued text. | Shown only for a message still in the "queued" state — a message the session has already received renders as plain, non-interactive text. |
| **Queued marker** `prompt-pending` | Reads "queued" beside a message still waiting to be sent. | Hidden once the message has gone or been withdrawn. |
| **Withdrawn marker** `prompt-withdrawn` | Reads "withdrawn"; the row stays (the event log is append-only) but its text is struck through and dimmed. | Hidden unless the message was withdrawn. |
| **Review in inbox** `review-in-inbox` | Emits `open-inbox` with the request's ID, which the parent view uses to open the Inbox panel and scroll straight to that pending item. | Shown only on a pending permission or plan marker. |
| **Error card** `error-event` | A red-bordered card showing the error text the session reported. | Shown only for error-kind events. |
| **Result line** `result-event` | A one-line summary of a completed turn: elapsed time, cost, and token count where each is available. | Shown only for result-kind events. |

Note: a Bash tool row deliberately hides the actual command in the clean view — it shows the model's own human description if one was supplied, otherwise a generic verb like "Ran a command"; the real command only appears in the raw view or the Inbox item detail.

### QuestionEvent

An amber card for an `AskUserQuestion`-style question from the session, with clickable option chips and an optional free-text answer.

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Question card** `question-event` | The whole question: label, question text, option chips, and (once answered) a confirmation line. | n/a. |
| **Option chip** `question-option-<option>` | Sends that option's label back to the session as the answer (`answer` emit). A chip marked "Recommended" is the session's suggested choice. | Disabled once the question has been answered — one answer only. |
| **Custom answer input** `question-custom-input` | A free-text field for an answer not among the offered options; Enter submits it, Escape or losing focus cancels. | Shown only after clicking "Other". |
| **Other** `question-custom` | Opens the free-text input in place of the chip. | Hidden once the question is answered (the "Other" affordance and the input share the same slot in the option row). |
| **Answered confirmation** `question-answered` | Reads "Answered: " followed by the clean text of whichever answer was sent. | Hidden until the question has been answered. |

### SwallowedBlock

A collapsed placeholder standing in for a run of routine tool noise the clean view would otherwise clutter with, e.g. "Worked quietly for a bit · read-heavy".

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Swallowed block** `swallowed-block` | Clicking the toggle line expands or collapses the block to show the individual swallowed lines (tool calls and their text) in a dark scrollable box. | Never disabled; starts collapsed. |
| **Open in Raw view** `swallowed-open-raw` | Emits `open-raw`, so the parent switches to the raw transcript view where the rest of a long run can be read in full. | Shown only once the block holds more than 100 events — below that cap, expanding the block already shows everything. |

### MiniTerminal

A small fixed-height, always-scrolled-to-bottom readout of a background session's live output, shown inline wherever that session's work was requested (for example, next to a "verify" or "diagram generate" action) — not a second copy of the full transcript, just proof that something is happening and what it is doing right now.

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Mini terminal** `mini-terminal` | Subscribes to the given session's live event tail on mount (`watchTail`) and unsubscribes when the session ID changes or the component unmounts; shows an optional label heading above the box. | n/a — always active once given a session ID. |
| **Waiting placeholder** `mini-terminal-empty` | Reads "waiting for output…". | Hidden once the first line of output arrives. |
| **Output line** `mini-terminal-line` | One line of the tail, most-recent lines pinned to the bottom. | n/a — one per line currently in the tail. |

### UsageCard

A structured rendering of a `/usage` response: limit meters and per-window activity lists, in place of raw prose.

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Usage card** `usage-card` | The whole card: a USAGE label, then limit meters, then one block per activity window. | n/a — rendered only once a `/usage` response has been parsed. |
| **Limit meter** `usage-meter` | One limit line: name, percentage (coloured green/amber/red by how close to the cap it is), a filled bar, and its reset time. | n/a — one per limit the report includes. |
| **Activity window** `usage-window` | One time-window's block: a title/volume header, then a dotted list of behaviours and "Top" entries (skills, subagents, plugins, MCP servers). | n/a — one per window the report includes. |

### MarkdownText

Renders an assistant message as formatted Markdown — bold, inline code, fenced code blocks, headings, lists, tables — from HTML that is escaped and tag-whitelisted before insertion, so it is safe to render directly.

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Markdown body** `markdown-text` | The rendered message. Clicking anywhere inside a fenced code block copies that block's exact text to the clipboard and shows a "copied" label for 1.2 seconds (a "copy" label shows on hover beforehand). Clicking outside a code block, or while the user is mid-selection of text inside one, does nothing. | Copy silently fails (label never appears) if the clipboard write is denied or unavailable — this is not surfaced as an error. |

Note: the "copy" and "copied" labels are pure CSS content on the `<pre>` element, not real buttons — because `v-html` re-renders wholesale on every streamed token, a button injected into the markup could not have survived a message still arriving; the copied-block index is tracked in component state instead and reapplied to the DOM after each re-render.

---

## Specs

This area is the per-project GitHub Spec Kit workflow: describe a feature, generate a spec, clarify it, plan it, break it into tasks, then implement — one spec at a time, with every stage command streaming into the project's session. When Spec Kit is not installed in the current project it shows an install prompt instead of the workflow.

### Not installed / empty states

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **(root)** `specs-view` | The whole Specs tab; wraps whichever of the three states below applies. | Never — always present. |
| **(panel)** `specs-not-installed` | Shown when Spec Kit has not been scaffolded into this project; explains what it adds. | Hidden once `specs.state` reports the project as installed. |
| **Install Spec Kit in this project** `specs-install` | Runs `specs.install`, which scaffolds Spec Kit into the project (an ephemeral `uvx` run, nothing global) and reloads the state; on success it selects the first spec it finds. | While an install is already running (label changes to "Installing…"). |
| **(error text)** `specs-install-error` | Shows the install failure message when `specs.install` throws. | Hidden when there has been no error. |
| **(panel)** `specs-empty` | Shown when Spec Kit is installed but the project has no specs yet. | Hidden once at least one spec exists. |
| **New spec** `specs-new-empty` | Opens the New Spec popup (same as `spec-new` below). | Never, while this panel is showing. |

### Spec chips and header

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Spec chip** `spec-chip-${id}` | Selects that spec — fetches its full detail via `specs.detail` and shows it below. One chip per spec, coloured by status (draft/ready/in-progress/complete). | Never disabled; one chip always exists per spec. |
| **New spec** `spec-new` | Opens the New Spec popup. | Never. |
| **Listen** `spec-listen` | Reads the selected spec aloud using the browser's Web Speech API — title, description, then each section, with markdown syntax stripped so it reads as prose. Clicking again while speaking stops it immediately. | Never disabled, but does nothing without a selected spec's detail loaded. |
| **Start implementation** `start-implementation` | Sends a background `/speckit-implement-scaffold` prompt asking the session to work through every remaining task in `tasks.md`, then jumps to the Session tab and polls for task completions every few seconds. | Hidden once the spec is complete, once a phase/implementation is already running, or when the spec has no tasks yet. |
| **(status text)** `implementing` | Reads "Implementing…" while a phase or full-spec run is in progress for this project. | Hidden when nothing is running. |

### Part tabs (spec.md / plan.md / tasks.md / Clarify / Commands)

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Tab** `part-${id}` | Switches the visible pane between spec.md, plan.md, tasks.md, Clarify and Commands for the selected spec. The Clarify tab carries a badge with the open-question count. | Never; five tabs always shown once a spec is selected. |

#### spec.md / plan.md

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **(panel)** `spec-sections` | Lists the parsed sections of whichever doc is selected (spec.md or plan.md), rendered as markdown. Shows a "No content parsed" note if the doc has no recognised sections. | Only shown while the spec.md or plan.md tab is active. |
| **Refine** `refine-${section title}` | Sets a spec-edit target naming this doc and section on the shared composer; the developer's next chat message is then understood as an edit aimed at that section. Does not send anything itself. | Never. |

#### Clarify

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **(panel)** `spec-clarify` | Shows the spec's open and resolved `[NEEDS CLARIFICATION]` questions, or a note that the spec has none. | Only shown while the Clarify tab is active. |
| **Answer in my own words** `answer-${question id}` | Sets a spec-edit target naming this specific question on the composer, so the next chat reply is understood as the answer to it. | Never. |
| **(row)** `resolved-clarification` | One row per already-answered clarification, showing the question, its answer, and that it was written into spec.md. | Never — one row exists per resolved question, none shown if there are none. |

#### Commands

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **(panel)** `speckit-commands` | Header for the suggested-next-step block. | Only shown while the Commands tab is active and a suggestion exists. |
| **(card)** `suggested-next` | Shows the genuinely next pipeline stage — worked out from which artefacts actually exist (unresolved clarifications block everything; no plan.md suggests `/speckit.plan`; no tasks suggests `/speckit.tasks`; all tasks done suggests `/speckit.checklist`; mid-run suggests `/speckit.analyze`; otherwise `/speckit.implement-scaffold`) — with a one-line reason. | Hidden once nothing is left to suggest (should not normally happen while a spec is loaded). |
| **Run** `suggested-run` | Sends the suggested command (with the spec id appended) to the session as a background run, then jumps to the Session tab. | Never. |
| **Command card** `speckit-cmd-${command}` | Re-runs any Spec Kit stage (`/speckit.clarify`, `.plan`, `.tasks`, `.analyze`, `.implement`, `.checklist`) scoped to the selected spec, as a background session run. | Never — all six stage commands are always offered. |

#### tasks.md

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **(panel)** `spec-tasks` | Lists tasks grouped by phase, with a note to run `/speckit.tasks` first if none exist yet. | Only shown while the tasks.md tab is active. |
| **Start phase** `start-phase-${phase label}` | Sends a background `/speckit-implement-scaffold` prompt scoped to just that phase's remaining task ids, then jumps to the Session tab and starts polling task completion for the whole spec. | Hidden once that phase is already fully done, is currently running, or any implementation run is already in progress. |
| **(row)** `task-done` / `task-todo` | One row per task, showing its id, label, and a tick or an empty box depending on completion. | Never — always present, one row per task. |
| **Refine (pencil)** `task-refine-${task id or label}` | Sets a spec-edit target naming this exact task on the composer, so the next chat reply edits that task. | Never. |

### New spec popup

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **(overlay)** `new-spec-popup` | The modal backdrop; clicking it (outside the box) or pressing Escape cancels and closes the popup. Traps Tab focus inside while open. | Hidden unless the New Spec popup is open. |
| **Description** `new-spec-input` | Free-text box for the one-sentence feature description. Enter submits it (Shift+Enter is not wired for a newline; the field is a plain textarea otherwise). | Never disabled; only meaningful while the popup is open. |
| **Cancel** `new-spec-cancel` | Closes the popup and discards the typed description. | Never. |
| **Create spec** `new-spec-submit` | Sends `/speckit-specify <description>` as a background session run and jumps to the Session tab. | Disabled when the description field is empty (whitespace-only counts as empty). |

Note: the Commands tab's "Run" and card clicks reuse the plain `speckit.implement` command, not the scaffold-and-verify variant that "Start implementation"/"Start phase" use — running a card manually skips the per-task completeness checklist the phase buttons apply.

## Diff

This area shows the project's uncommitted working-tree changes — tracked and untracked files together — with one file's diff shown on selection. It is read-only by design: there is no stage, discard, or revert control anywhere in it, and it only works while the project has a live session (the diff is read from that session's sandbox/working copy).

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **(root)** `diff-view` | The whole Diff tab; wraps whichever state below applies. | Never. |
| **(notice)** `diff-not-live` | Tells the developer to start a session first — the diff cannot be read without one. | Hidden once the project has a live session. |
| **(notice)** `diff-git-notice` | Shows a git-specific problem message returned by the backend (for example, the folder is not a git repository). | Hidden when there is no such notice. |
| **(notice)** `diff-no-changes` | Reports that the working tree currently has no changes. | Hidden once at least one changed file is returned. |
| **(list container)** `diff-file-list` | The left-hand column: changed files grouped by folder, root files first, then folders alphabetically depth-first, with each folder heading carrying rolled-up add/remove totals for everything folded beneath it. | Only shown once there are changes to list. |
| **Folder heading** `diff-folder-${dir or 'root'}` | Folds or unfolds that folder's files (and its subfolders); the heading itself keeps reporting the subtree's total file count and line counts even while folded. | Never — every folder heading is always clickable. |
| **File row** `diff-file-${path}` | Selects that file, fetching its diff content via `diff.file` and showing it in the right-hand pane. Marked selected while its diff is showing. | Never — every listed file is selectable; hidden only while its folder is folded. |
| **(pane)** `diff-pane` | The right-hand panel that shows one of the four states below depending on selection. | Never — always present once there are changes. |
| **(placeholder)** `diff-pane-empty` | "Select a file to see its diff" — shown before any file is picked. | Hidden once a file is selected. |
| **(status)** `diff-pane-loading` | Shown while the selected file's diff content is being fetched. | Hidden once the fetch resolves. |
| **(notice)** `diff-pane-gone` | Reports that the previously selected file no longer has a change to show (it dropped out of the working tree since selection, e.g. the developer reverted it outside the app). | Hidden while the file still has a diff. |
| **(notice)** `diff-pane-binary` | Reports that no text diff is available (binary file). | Hidden for text files. |
| **(diff lines)** `diff-pane-lines` | The actual unified-diff lines for the selected file — added, removed and context lines each styled distinctly, with a leading +/−/blank marker. | Hidden unless a text diff has loaded. |

Note: file counts are deliberately never fabricated — a binary or otherwise uncountable file shows "binary" rather than a false "+0 −0", and a folded folder's heading still reports genuine totals for what is hidden inside it rather than going silent.

## Database MCP

This area is a dedicated chat against the project's Database MCP server(s): the developer ticks which servers to include, runs a scan that has the session (via the Task tool, in parallel where useful) write a combined schema map to a cached markdown file, and afterwards asks questions that the session answers by querying those servers and consulting that cached map instead of re-scanning. Each distinct combination of servers keeps its own scan and its own history entry. It shares the project's live Agent SDK session with the rest of the app (starting one here, or elsewhere, is the same session).

### Header

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **(root)** `mcp-view` | The whole tab. | Never. |
| **Stop** `mcp-stop` | Interrupts the current turn (Ctrl+C equivalent) via `sessions.interrupt`. | Hidden unless the session is currently working. |
| **(row)** `mcp-servers` | Lists every server on this view's roster (set in Settings → MCP) as toggle chips. | Hidden if the roster is empty (a hint to add servers in Settings is shown instead). |
| **Server chip** `mcp-chip-${name}` | Toggles that server in or out of the active combination — the set of servers the chat and scans currently target. Shows a live connection-status dot from the session's reported MCP status. | Never — every roster entry is always toggleable. |
| **(row)** `mcp-combo` | Shows the active combination's name, whether it's been scanned before (and how long ago), or a hint to tick a server if none is active. | Never — always present. |
| **(text)** `mcp-combo-name` | The current combination's key (its server names joined). | Hidden while no server is ticked. |
| **(text)** `mcp-combo-scanned` | "scanned <relative time>" — shown when this combination has a recorded scan. | Hidden when this combination has never been scanned. |
| **(text)** `mcp-combo-never` | "never scanned" — shown when this combination has no recorded scan yet. | Hidden once it has been scanned. |
| **Scan / Re-scan** `mcp-combo-scan` | Sends the scan prompt for the active combination to the session (switches to the Chat sub-tab first), asking it to enumerate structure across all ticked servers and write a combined schema-map file; a completed scan is recorded once the session goes idle and the doc is confirmed written. | Disabled while the session is currently working; hidden entirely when there is no live session. |
| **(row)** `mcp-history` | Lists every combination ever scanned for this project, newest alongside oldest, each as a chip with its relative scan time. | Hidden when nothing has ever been scanned. |
| **History chip** `mcp-history-${comboKey}` | Re-activates that past combination — restores its servers to the roster (ticking them all) and makes it the active combination, so its cached doc and chat re-appear. | Never — every history entry is always clickable. |

### Tabs and scan banner

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Chat** `mcp-tab-chat` | Switches to the chat/event stream sub-view. | Never. |
| **db-schema.md** `mcp-tab-md` | Switches to the read-only rendered view of the current combination's cached schema doc. | Hidden until this combination has been scanned at least once. |
| **Re-scan** `mcp-rescan` | Same scan action as `mcp-combo-scan`, offered again here so it's reachable without scrolling to the header. | Disabled without a live session, while the session is working, or with no server ticked; only shown once a scan already exists and the Chat tab is active. |
| **(banner)** `mcp-scanning` | "Scanning your MCP servers…" status banner shown for the duration of a scan. | Hidden outside an active scan. |

### Empty / start states

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **(panel)** `mcp-empty` | Shows either a "start the session" or "no schema map yet" prompt, whichever applies. | Hidden once there is a live session with either a scan or chat history. |
| **Start MCP session** `mcp-start-session` | Starts a normal session for this project (the reserved Database project) via `projects.startSession`; MCP access comes from the project's own `.mcp.json`, not from anything this view sets. Shows an inline error if starting fails (for example, another session is already active). | Hidden once a live session exists. |
| **Scan combination** `mcp-scan` | Same scan action as `mcp-combo-scan`/`mcp-rescan`, shown as the primary call-to-action when there is a session but no schema map yet. | Disabled when no server is ticked (tooltip explains why). |
| **db-schema.md re-scan** `mcp-doc-rescan` | Re-runs the scan from within the rendered-doc sub-tab. | Disabled without a live session, while working, or with no server ticked. |

### Chat stream and composer

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **(doc panel)** `mcp-doc` | Read-only render of the current combination's cached schema markdown. | Only shown on the db-schema.md sub-tab. |
| **(stream)** `mcp-stream` | The scrollable event/question stream for this project's session, main-loop events only (subagent internals stay folded in). Capped to the last 500 events for render performance. | Only shown on the Chat sub-tab. |
| **(suggestion list)** `mcp-suggest-list` | Slash-command/skill autocomplete dropdown for the composer, sourced from the project's own command list. | Hidden unless the typed text matches at least one suggestion. |
| **Suggestion item** `mcp-suggest-item-${index}` | Accepts that suggestion into the composer. | Never — one per matching suggestion. |
| **Composer** `mcp-composer` | Free-text input. Plain questions are wrapped with an MCP-targeted prompt naming the active servers and pointing at the cached doc; a line starting with `/` goes to the session raw and works even with no server ticked, so `/mcp` or a plugin skill can be run to fix a broken MCP state. Enter sends (via the shared command-suggestion composable). | Disabled when there is no live session. |
| **Send** `mcp-send` | Sends the composer's contents using the rule above. | Disabled when the composer is empty, there is no live session, or (for a non-slash message) no server is ticked. |

Note: the "no server ticked" guard is bypassed on purpose for slash commands — it is the one way out of a stuck MCP roster with nothing ticked, since a plain question has nowhere useful to send.

---

## Tests

The Tests area is the verification surface for one project: pick a stack, choose which suites a run covers, start it, then read the result across six gates and drill into detail panels. A run never happens as a bare process; it always executes inside a Claude Code session (the project's dedicated background session, not the chat session), so its output can be inspected in the Session tab as well as here.

### Stack picker

Shown only until a stack has been chosen for this project. Once chosen, the picker is replaced by the workspace below.

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Root panel** `tests-view` | The section's container. Renders the stack-picker intro before a stack is chosen, the full workspace afterwards. | Never hidden; its content changes. |
| **Detect hint** `tests-detect-hint` | Reads out what project-file detection found ("Looks like … from the project files") or says nothing conclusive turned up. | Always shown in the picker state. |
| **Stack row** `tests-stack-${id}` | Sets this stack as the project's chosen verification stack (saved to settings) and switches to the workspace. A stack detection found is marked DETECTED, but any stack can be picked as an override. | Never disabled. |

### Profile header and run controls

Shown once a stack is chosen. `tests-change-stack` clears the choice back to nothing, returning to the stack picker.

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Suite count** `tests-suite-count` | Readout: how many suites are selected out of how many are offered. | n/a (text only) |
| **Change stack** `tests-change-stack` | Clears the project's chosen stack and returns to the stack picker. | Never disabled. |
| **Run state** `tests-run-state` | Readout (`role="status"`, announced to screen readers): "Running…" or "Last run passed/failed", plus when and on which branch. Added specifically because a run in progress announces nowhere else while the developer works in another panel. | Shown only once a run exists. |
| **Estimate line** `tests-estimate` | Readout of how long this selection of suites usually takes, learned from this project's past runs with the same selection. | Shown only when a comparable past run exists. |
| **Suite chip row** `tests-suites` | Container for the suite toggle chips below. | n/a |
| **Suite chip** `tests-suite-${id}` | Toggles one suite in or out of the next run's selection. Heavy suites (marked "slow") start unticked by default. | Disabled, and marked with the blocking reason (e.g. "python is not in the bypass container"), when the current session's sandbox cannot run that suite's required tool. |
| **Edit command** `tests-suite-edit-${id}` (pencil icon) | Opens an inline text field to override the catalogue's guessed shell command for that suite, for this project. | Never disabled. |
| **Command input** `tests-suite-command-${id}` | The overridden command text. Enter or losing focus saves it (or clears the override if left empty or typed back to the default); Escape cancels. | Shown only while editing that suite's command. |
| **Working tree** `tests-target-tree` | Always shown selected. It does not carry a click handler — the only verification target the app currently supports is the working tree, so this reads as a fixed label rather than a real toggle. Surprised us: it looks like a picker but there is nothing else to pick yet. | Always present, never interactive. |
| **Capture evidence** `tests-evidence` | Executes the changed code (through the run's session, or a fresh one) and records what it actually produced as evidence, without re-running the suites. Switches to the Results tab on success. | Disabled when there is no run yet, or while one is running. |
| **Cancel** `tests-cancel` | Stops the session's current turn and closes the run as inconclusive, marked as stopped by the developer rather than a session giving up. Stops whatever the session is doing, not only the tests. | Only rendered while a run is in progress. |
| **Run verification** `tests-run` | Starts a run over the selected suites in the project's dedicated background session, then switches to the Results tab. | Disabled while starting, while already running, or when no suite is selected. |
| **Error line** `tests-error` | Readout of the last verify-store error (e.g. a failed start). | Shown only when an error is set. |

### Score and the six gates

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Score** `tests-score` | Readout: percentage of *measured* gates that came back clean (green only at 100%). Unmeasured gates are excluded from the denominator rather than counted as failures. | Reads "—" when nothing has measured anything yet. |
| **Score detail** `tests-score-sub` | Readout: "X/Y gates clean, Z unmeasured". | Reads "nothing measured yet" with no run. |
| **Gate tile** `tests-gate-${id}` (six: unit, integration, architecture, coverage, mutation, and the external quality-service gate) | Jumps the sub-tab to that gate's own panel (Results, API, Coverage or Quality). | Never disabled; always clickable even with nothing measured. |
| **Verified mark** `tests-gate-verified-${id}` ("checked") | Readout mark shown only when every suite behind that gate was confirmed against the test runner's own report file rather than taken on the session's word. | Shown only when that condition holds. |

### Sub-tab bar and panels

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Sub-tab** `tests-sub-${id}` (API, Results, Coverage, Quality, Manual QA, Skill) | Switches the panel shown below. Manual QA carries a badge of pending acceptance lines. Skill is marked "in development" but is still clickable; it opens a static placeholder panel, not a disabled tab. | Never disabled. |

#### API eval set panel (`subTab === 'api'`)

Real HTTP calls the app makes itself against a running API, with the request identifiers supplied by the session and the pass/fail verdict computed in code, never claimed by the session.

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Panel** `tests-panel-api` | Container; header shows a run summary and its verdict chip. | n/a |
| **Base URL** `tests-api-base` | Local API base URL field. Only takes effect once Save is pressed. | Never disabled. |
| **Start command** `tests-api-start` | Command used to start the API locally if nothing already answers at the base URL. | Never disabled. |
| **QA URL** `tests-api-qa` | Base URL of a deployed environment the app can call read-only. | Never disabled. |
| **QA headers** `tests-api-qa-headers` | Extra headers sent on QA calls; a value written as `${VAR}` is resolved from the environment at call time and never stored as a literal. | Never disabled. |
| **Save** `tests-api-save-host` | Writes the four fields above for this project. | Never disabled. |
| **Host source** `tests-api-host-from` | Readout of where the local base URL came from, or an error. | n/a |
| **QA source** `tests-api-qa-from` | Readout explaining the QA-header handling, or a QA-specific error. | n/a |
| **Recently tested chip** `tests-api-recent-${i}` | Toggles one of the last-tested (or, if none yet, first-scanned) endpoints into the pick list for the next run. | Never disabled. |
| **Search field** `tests-api-search` | Filters the full endpoint list below by path, method or source file. | Never disabled. |
| **Endpoint row** `tests-api-endpoint-${i}` (checkbox role) | Toggles that endpoint into or out of the pick list. | Never disabled. |
| **Local target** `tests-api-target-local` | Selects "this machine" as where the next run's calls go; the app starts the API itself if nothing answers. | Never disabled. |
| **QA target** `tests-api-target-qa` | Selects the deployed QA environment (never started or stopped by the app, reads only). | Disabled until a QA URL has been saved. |
| **Estimate** `tests-api-estimate` | Readout of how long an API eval set of this size usually takes. | Shown only when history exists. |
| **Cancel** `tests-api-cancel` | Stops the session's data-gathering turn; calls already in flight from the app's own loop finish on their own. | Only rendered while a run is in progress. |
| **Run against local/QA** `tests-api-run` | Starts the eval set: session supplies real identifiers, the app makes the HTTP calls itself. | Disabled while starting, while running, or with nothing picked. |
| **Error line** `tests-api-error` | Readout of the last API-store error. | Shown only when set. |
| **Write test report** `tests-api-report` | Writes the full report for the latest run to `.switchboard/reports`. Offered for any finished run, not only one just made. | Disabled with no run, or while one is running. |
| **Report path** `tests-api-report-path` | Readout of where the report was written. | Shown only after a successful write. |
| **Run note** `tests-api-note` | Readout of a note attached to the run (e.g. a partial-failure explanation). | Shown only when the run carries one. |
| **Call row** `tests-api-call-${i}` | Readout of one HTTP call: outcome, method, path, status, timing, what was checked, and the response body. | n/a |

#### Results panel (`subTab === 'evidence'`)

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Panel** `tests-panel-evidence` | Container; header shows the run summary and verdict. | n/a |
| **Run note** `tests-run-note` | Readout of a note attached to the latest run. | Shown only when present. |
| **Suite result row** `tests-result-${id}` | Readout: one suite's status, label and detail from the report. | n/a |
| **Endpoints-empty note** `tests-endpoints-empty` | Readout explaining, specifically, why no real endpoint calls are shown (no API suite requested, still running, no report, no database MCP server connected, or the suite ran but reported nothing). | Shown only when the endpoint list is empty. |
| **Endpoint row** `tests-endpoint-${i}` | Readout of one real endpoint call made during the run: outcome, method, path, status, timing, data source, and the assertion checked. | n/a |
| **Evidence row** `tests-evidence-${i}` | Readout of one piece of captured evidence: what was executed, the actual result, and, if any, the path it came from. | n/a |

#### Coverage panel (`subTab === 'coverage'`)

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Panel** `tests-panel-coverage` | Container; header shows the run summary. | n/a |
| **Line coverage** `tests-coverage-line` | Readout of overall line coverage, and its source, or "—" if unmeasured. | n/a |
| **Changed-lines coverage** `tests-coverage-changed` | Readout of coverage restricted to lines changed in this diff, and its source. | n/a |

#### Quality panel (`subTab === 'quality'`)

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Panel** `tests-panel-quality` | Container; header shows the run summary. | n/a |
| **Quality gate** `tests-quality-gate` | Readout of the external quality service's own pass/fail gate, or "not connected". | n/a |
| **Duplication** `tests-quality-duplication` | Readout of duplication percentage and its source. | n/a |
| **Debt** `tests-quality-debt` | Readout of a debt figure; its source line distinguishes "not configured" from "nothing measured it". | n/a |
| **Mutation** `tests-quality-mutation` | Readout of mutation-score percentage and its source. | n/a |

#### Verify skill (in development)

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Placeholder panel** `tests-dev-skill` | Static "in development" panel describing a planned generated per-project test skill. Nothing to click; the stack catalogue does this job today instead. | Always in this state; the feature does not exist yet. |

## Tests — the eval loop

This is the eval-loop workflow embedded as the "Manual QA" sub-tab of Tests: one observable acceptance line per small change, an optional check, then implement, verify, judge and record a verdict and rating. Nothing here spawns its own process; the check, the attempts, and the judge pass all run through the same background session the verification runs use, so a dispatch's real output appears in the Session tab.

### Adding a line

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Root panel** `evals-view` | Container for the whole eval loop. | n/a |
| **Acceptance field** `eval-acceptance` | The observable statement of what "working" looks like (a testid, a label, a status). Enter also submits. | Never disabled. |
| **Check field** `eval-check` | Optional command that proves the acceptance line, e.g. a `vitest run` invocation. Enter also submits. | Disabled while the acceptance field is empty. |
| **Add line** `eval-add` | Adds a new acceptance line (with its optional check) to this project's list. | Disabled while the acceptance field is empty. |
| **From a suite** `eval-suites-toggle` | Expands or collapses a list of the project's own detected test suites, offered as ready-made acceptance lines. | Never disabled. |
| **Error line** `eval-error` | Readout of the last evals-store error. | Shown only when set. |
| **Suite list** `eval-suites` | Container shown when "From a suite" is expanded; explains there is nothing to offer if no stack was detected. | Shown only while expanded. |
| **Suite row** `eval-suite-${id}` | Adds a line pre-filled from that detected suite's own acceptance text and command. | Never disabled. |

### Summary

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Line count** `eval-count` | Readout: number of acceptance lines recorded for this project. | n/a |
| **Pass rate** `eval-pass-rate` | Readout: percentage of *decided* lines (verdict set) that passed. Pending lines are excluded rather than counted as failing. | Reads "—" when nothing has a verdict yet. |
| **Mean rating** `eval-mean` | Readout: mean of the 1-5 ratings given so far. | Shown only when at least one line has been rated. |

### Line rows

Each acceptance line renders as one row with the following controls, all keyed by `run.id`.

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Row** `eval-row-${id}` | Container for one acceptance line. | n/a |
| **Stage badge** `eval-stage-${id}` | Readout of the line's derived stage: implement, verify, review, or done. Derived from the check status, judge text and verdict, never stored separately, so it can never drift out of sync. | n/a |
| **Remove** `eval-remove-${id}` | Deletes this acceptance line entirely. | Never disabled. |
| **Check status chip** `eval-check-status-${id}` | Readout: "check not run" or the last check outcome. | n/a |
| **Attempts chip** `eval-attempts-chip-${id}` | Readout of how many isolated attempts this line is set to run. | Shown only when more than one attempt is configured. |
| **Judge note** `eval-judge-${id}` | Readout of the judge's written verdict, once one exists. | Shown only after a judge pass has run. |
| **Run check** `eval-run-check-${id}` | Sends the check command to the session and records the pass/fail it reports. | Only rendered when the line has a check command. |
| **Launch & look** `eval-manual-${id}` | Hands the session a prompt to launch the app in the background, screenshot the affected screen, and report in four lines what to click, what to look for, and the likeliest thing wrong. This is the manual pass; it does not run a check command. | Never disabled. |
| **Implement / N attempts** `eval-attempts-run-${id}` | Dispatches the "attempts" work to the session: one straight implementation run, or several isolated attempts with the best kept, per the attempt count set below. | Never disabled. |
| **Judge** `eval-judge-run-${id}` | Dispatches a judge pass to the session, which writes its verdict text back onto the line. | Never disabled. |
| **Attempt-count chip** `eval-attempts-${id}-${n}` (1, 2 or 3) | Sets how many isolated attempts the next "Implement" dispatch should run, without dispatching anything itself. | Never disabled. |
| **Pass** `eval-verdict-pass-${id}` | Records the line's verdict as pass. | Disabled until the check has actually passed (a line with no check is never gated here, since the manual pass covers it). |
| **Gated note** `eval-gated-${id}` | Readout explaining why Pass is currently blocked (e.g. "gated — the check has reported"). | Shown only while Pass is disabled. |
| **Fail** `eval-verdict-fail-${id}` | Records the line's verdict as fail. | Never disabled. |
| **Rating star** `eval-rate-${id}-${n}` (1-5) | Sets the 1-5 rating; clicking the currently-lit star clears the rating back to none. | Never disabled. |
| **Reloop note** `eval-reloop-${id}` | Readout warning shown when the rating is 3 or below, suggesting the check needs tightening before looping again. | Shown only when the rating qualifies. |
| **Note field** `eval-note-${id}` | Free-text note on the line, saved on blur/change. | Never disabled. |

---

## Cleanup

This area lists curated code-review and cleanup slash commands from installed plugins (currently dotnet-claude-kit and ponytail), grouped by source, so a developer can run one against the current project without typing it. A group that is not installed shows a card to fetch it instead of its commands. Every dispatched command runs in the project's shared background session, not the visible conversation, and its output is shown live at the foot of the tab.

### Layout and status

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Cleanup panel** `cleanup-view` | The whole tab: an intro line naming the project, then one card per command group. | Always present once the Cleanup tab is open. |

### Command rows (per installed group)

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Command row** `` cleanup-cmd-${c.command} `` | Sends the matching slash command (e.g. `/dotnet-claude-kit:de-sloppify`) to the project's background session. Resolves the namespaced form the session actually reports rather than the catalogue's bare name, so the plugin's own command runs rather than a same-named built-in. The row's output streams into the mini terminal at the bottom of the tab. | Greyed out and inert when this exact command is not in the session's own command list (its title explains the plugin may not ship it or may have been renamed). Before the session has reported any commands, every row is treated as available so the group is not shown empty. |

### Install card (per group not yet installed)

A stack-specific group (currently the .NET toolkit) is hidden entirely until it is installed; ponytail, being stack-agnostic, always shows either its commands or this card.

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Download to project** `` cleanup-install-${g.source} `` | Runs the plugin's marketplace-add then install subcommands on the host CLI and, on success, refreshes the session's known command list so the card retires itself without waiting for a new session. | Disabled and reads "Installing…" while any install (for any group) is already running. |
| **Install error text** `` cleanup-install-error-${g.source} `` | Shows the CLI's own failure message when the install above failed. | Not shown when there has been no failed attempt for this group. |

*Note*: the badge, blurb and command-list/install-card switch are not separate testids — `isInstalled(g)` alone decides whether a group shows its command rows or its install card; a group counts as installed the moment any one of its commands matches, even if the catalogue lists others the plugin does not actually ship (those individual rows still disable correctly).

## Diagrams

This area lets a developer describe a diagram in plain language; the project's background session draws it with the diagram-design plugin and writes a standalone HTML file into the project's `docs/diagrams` folder. Drawing has no slash command of its own — it is an ordinary request that triggers the plugin's skill — but the plugin also ships three commands (export, and two importers) reachable from a small menu. A generated diagram appears in a list on the left and renders in a sandboxed preview pane on the right.

### Layout, install and status

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Diagrams panel** `diagrams-view` | The whole tab: intro text, the install card (if needed), the input row, the diagram list and the preview pane. | Always present once the Diagrams tab is open. |
| **Install error text** `diagrams-install-error` | Shows the CLI's own failure message under the install card. | Not shown when there has been no failed install attempt. |
| **Download to project** `diagrams-install` | Runs the diagram-design plugin's marketplace-add then install subcommands on the host, then refreshes the session's command list. | Disabled and reads "Installing…" while the install is running. Also, the whole install card is hidden (not merely enabled) once the project already has diagrams, has one on the way, or the session has not yet reported its command list — the app judges by evidence of the plugin's output rather than trusting a probe that runs inside a container with its own separate plugin state. |

### Generating a diagram

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Description field** `diagram-input` | Free-text box for what the diagram should show. Pressing Enter also triggers generation. | Disabled while a generation request is in flight. |
| **Generate** `diagram-generate` | Sends the typed description to the project's background session (starting one if none is live) as a request to draw the diagram, clears the box, and shows the request as a "pending" row until the file appears in the folder (polled every 2.5 seconds, for up to twenty minutes). Nothing switches tabs — the diagram turning up in the list here is the whole answer. | Disabled while a generation request is already running, or while the description field is empty. |

### Commands menu

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Commands** `diagram-commands` | Opens or closes a small menu of the plugin's three non-drawing commands (export, and the two importers). | Always available; toggles open/closed. |
| **Command menu** `diagram-command-menu` | The floating list itself, one row per command. Clicking anywhere outside it (the invisible scrim behind it) closes it without a document-level listener. | Not shown while closed. |
| **Command item** `` diagram-command-${c.command} `` | Dispatches the chosen command to the background session, e.g. `/diagram-design:export-diagram`, with an argument: whatever is typed in the description box if present, otherwise — for the export command only — the path of the diagram currently selected in the preview pane. Closes the menu and clears the box. | Disabled, and marked "not in this project", when this command is not in the session's reported command list. Before the session has reported any commands, every item is treated as available. |
| **Error text** `diagram-error` | Shows a failed load or generate error (including the twenty-minute "has not appeared" timeout message). | Not shown when there is no current error. |

### The diagram list and preview

| Control | What it does | Unavailable when |
| --- | --- | --- |
| **Pending row** `diagram-pending` | A placeholder row for a diagram just requested but not yet written to disk, naming the file the app already chose and showing that session's live output. Disappears the moment the file lands (the pane then switches to show it) or after the twenty-minute poll budget runs out. | Not shown once the file has appeared, or once polling has given up, or when no generation is in flight for this project. |
| **Empty state** `diagrams-empty` | Tells the developer no diagrams exist yet for this project and names the folder they would be written to. | Not shown once at least one diagram exists or one is pending. |
| **Diagram list** `diagram-list` | The scrollable column of past diagrams for this project, newest first by file modification time. | Not shown when the list is empty and nothing is pending. |
| **Diagram row** `` diagram-row-${d.file} `` | A single click selects the diagram, loading and caching its HTML for the preview pane (cached HTML shows instantly on re-selection). A double-click opens the same file directly in the system's default browser via the host shell, bypassing the in-app preview. | Always clickable once listed. |
| **Open in browser** `` diagram-open-${selected} `` | Opens the currently selected diagram file with the OS's default handler (same action as double-clicking its row). | Only rendered when a diagram is selected. |
| **Diagram frame** `diagram-frame` | An iframe rendering the selected diagram's raw HTML via `srcdoc`. It carries no `sandbox="allow-scripts"` and inherits the app's script-src-self CSP, so any script embedded in a generated diagram is inert — it always renders as a static picture, never runs code. | Shows a "reading…" placeholder in place of the frame while the HTML is still being fetched; the split view itself is not shown at all when the list is empty and nothing is pending. |

**Notes for the owner**: both views route all "run a command" and "install a plugin" actions through the parent SessionView, which sends work to one shared per-project background session (`specs.runInSession(..., background: true)`) rather than the visible chat — a detail worth knowing since neither view's own store touches a session directly except Diagrams' own generate/open/read calls. The diagram iframe's empty `sandbox` attribute is a deliberate security control called out in the source comment; do not add `allow-scripts` to it.
