# Switchboard functional audit

Date: 2026-08-15

## 1. Verdict

The application is functionally sound in its core session-hosting loop, but it carries a working set of concrete, mostly small-effort bugs concentrated at the seams between features that were added at different times (the multi-session lift on 2026-08-05, the container sandbox, the plugin marketplace). Three findings are serious enough to fix before wider use: retention can delete a still-running session's transcript, the Diff tab misreports staged changes as binary, and the Cleanup tab silently fails on seven of its nine commands because they are dispatched into a session that structurally cannot see the plugin. None of the findings below indicate an architectural problem; each is a local fix within the file or function already responsible for the behaviour.

## 2. Proposals, ranked

### Do next (high benefit, S/M effort)

**Nightly retention can delete a still-running session's own events**
File: `src/main/store/retention.ts:28-33`. The keep-set ranks sessions by `startedAt DESC` per project with no `endedAt` filter. Since a project can now run 3+ concurrent sessions, the oldest-started of them can be pruned mid-conversation, deleting its visible history while it is still in use.
Change: add `AND sessionId NOT IN (SELECT id FROM sessions WHERE endedAt IS NULL)` to the keep-set query, without deciding the separate open question of how many ended sessions to retain.
Risk: none functional; slightly more storage kept during long uptimes with many concurrent sessions.

**Diff tab reports staged changes as binary and shows an empty diff for them**
File: `src/main/sessions/session-manager.ts:268-272` (`readNumstat`, no `--cached`/`HEAD`), `:454-460` (`readFileDiff`, same gap). `git status --porcelain=v1 -z` lists staged files, but `git diff --numstat`/`git diff -- path` only ever compare the index to the working tree, so a staged change (an ordinary `git add`, or an IDE stage button) returns no numstat row and an empty diff. DiffView.vue renders the missing count as the literal word "binary" and opens a blank pane with no explanation. Reproduced directly against a real git checkout, including the staged-rename case.
Change: use `git diff HEAD --numstat` and `git diff HEAD -- path` in both functions, matching the span `git status` already covers. Guard the unborn-branch case (zero-commit repo) the same way `readGitBranch` already does.
Risk: very low; this only widens what the same two queries report.

**Cleanup section's plugin commands are dispatched to a session that structurally can never see the plugin**
Files: `src/renderer/views/SessionView.vue:1416-1425` (CleanupView wired to `runInSection`, background=true) versus `:1429-1437` (DiagramsView wired to `runPluginCommand`, background=false, with a comment explaining exactly why background fails for plugin commands); `src/main/sessions/session-manager.ts:825-833` (`onCommands` drops a containerised session's command list); `:1036-1059` (`backgroundSessionFor` is unconditionally containerised, so its fresh `~/.claude` volume has no plugins). Seven of Cleanup's nine command rows (`de-sloppify`, `security-scan`, `health-check`, `migrate`, `ponytail-review`, `ponytail-audit`, `ponytail-debt`) can never resolve when routed this way, regardless of the "Installed" badge shown.
Change: route CleanupView's `@run` through `runPluginCommand`, the fix the codebase already applied to the identical Diagrams case.
Risk: trades background dispatch for live-session dispatch (queues behind whatever the developer is doing in chat), the same trade already accepted for Diagrams.

**A multi-suite .NET run misattributes one suite's TRX results to another**
File: `src/main/evals/artefacts.ts:130-159` (`collectArtefacts` keeps only the single newest `*.trx` across the whole scan), `:191-212` (`reconcile` stamps that one file's counts onto every `RUNNER_SUITES`-matching suite: `dotnet-unit`, `dotnet-coverage`, `dotnet-api`, `dotnet-arch`). `dotnet-unit` and `dotnet-coverage` both run by default and both write their own TRX; the file that is read for one suite is often the other suite's file, so a passing unit suite can be reported as failed or a real failure masked as passed.
Change: scope artefact discovery per suite (a per-suite output path, or tag each discovered TRX to a suite window using the existing `SUITE_MARKER` timestamps) and leave a suite's figure unverified when no unambiguous file can be found, rather than borrowing another suite's.
Risk: if suite-window inference is imprecise, it must fail safe to "unverified", using the existing "no artefact changes nothing" fallback.

**Starting two containerised sessions in quick succession can race past MAX_CONTAINERS**
File: `src/main/sessions/session-manager.ts:617-648` (`refuseWhenContainersFull()` counts `this.hosted` synchronously, then awaits `ensureSandboxImage` and other setup, well before `this.hosted.set()` at `:889`). Two containerised starts landing close together both read the same under-count and both pass, oversubscribing the cap the constant exists to enforce (see its own comment on the crash it replaced).
Change: reserve a slot synchronously the moment the check passes (a counter or placeholder Set alongside `hosted`), released in the existing catch block or once `hosted.set()` succeeds.
Risk: low; must release the reservation on every exit path or the count ratchets upward and refuses valid starts. Add a unit test for two concurrent containerised starts with one slot remaining.

**Queued planned tasks can be delivered into a background container session instead of the developer's chat**
File: `src/main/sessions/session-manager.ts:930-946` (`liveEntryForProject` returns the first hosted entry for a project in Map insertion order, no preference for the non-background entry), `:1036-1059` (`backgroundSessionFor` starts a second, containerised entry for the same project). If that background session goes idle first, `maybeDrainQueue` silently delivers the developer's queued prompt into it instead of the visible chat.
Change: in `maybeDrainQueue`, prefer `[...hosted.values()].find(e => e.row.projectId === projectId && !e.background)`, falling back to any entry only if none exists. Leave the pure-liveness call sites in `ipc/handlers.ts` unchanged.
Risk: none functionally; only narrows which existing entry is targeted, with a fallback preserving today's single-session behaviour.

**Notification click for a background subsession's question finds no project and does nothing**
File: `src/renderer/App.vue:92-100` matches `p.session?.id === push.sessionId`, but `p.session` is only the currently focused subsession (`src/shared/ipc-types.ts:174-192`), not any of the project's sessions. A toast for a background subsession's question matches nothing, and clicking it does nothing beyond restoring the window.
Change: match on `p.sessions.some(s => s.id === push.sessionId)`, then call `projects.select(project.id)` and `projects.focusSession(project.id, push.sessionId)` (the pairing Sidebar.vue's `focusSub` already uses) before `active.focusEvent(push.eventId)`.
Risk: none; reuses an existing, proven path.

**Node/Python "HTTP smoke" suite is offered, and defaulted on, for projects with no HTTP server**
File: `src/shared/test-catalog.ts:270-334` (`node-api`) and `:356-363` (`py-api`) carry no `appliesTo`/shape check, unlike the dotnet stack's `detectAppShapes` (`:527-567`), built specifically to stop a browser suite being offered to a headless service. `defaultSelection` (`:458-460`) ticks both on by default for any project matched only by `package.json`/`pyproject.toml`, including Switchboard itself.
Change: extend the same cheap heuristic already used for `needsBrowser()`: detect a server dependency (express/fastify/koa/hapi/@nestjs, or Flask/FastAPI/Django) before offering these suites, gating them the same way `appliesTo` gates the Blazor suites.
Risk: a missed unusual server structure costs one skipped suite with a stated reason, the same direction the existing shape-detection code already errs in.

**Duplicate-project-path detection is case-sensitive on a case-insensitive filesystem**
File: `src/main/store/db.ts:50` (`UNIQUE` uses default binary collation), `src/main/store/repositories.ts:180-185` (`byPath` exact `=` match), `src/main/projects/discovery.ts:32-35,86-90` (register/repoint duplicate checks built on `byPath`). `suggestProjects` in the same file already lower-cases paths to catch this exact class of bug; registration and repoint never got the fix, so two differently-cased paths to the same folder register as two live rows, each free to run a session against the same working tree.
Change: normalise the comparison (lower-case both sides) in `byPath` and its callers, mirroring `suggestProjects`, without altering the stored/displayed path.
Risk: none functionally; a pre-existing duplicate is not retroactively merged.

**Standing-rule revoke/restore report success even when the id does not exist**
File: `src/main/ipc/handlers.ts:930-935` calls the repo directly with no existence check; `src/main/store/repositories.ts:535-542` (`revoke`/`restore`) run an UPDATE with no row count checked. Every other id-addressed mutation on this surface (rename, archive, session-mode change) throws NOT_FOUND first.
Change: check existence, or read back the affected row count, and throw NOT_FOUND when nothing changed.
Risk: none functionally; grep call sites first, since any caller currently ignoring the resolved promise would start seeing an occasional NOT_FOUND.

**SpecsView swallows session-dispatch failures with no user-facing message**
File: `src/renderer/views/SpecsView.vue:139-148,150-167` call `void specs.startPhase(...)` with no `.catch`; `src/renderer/stores/specs.ts:89-100` re-throws after its own cleanup, and nothing downstream catches it. The failure is reachable in practice: every phase-implementation run goes through the always-containerised `backgroundSessionFor`, which throws outright when Docker Desktop is not running (`docker-sandbox.ts:463-468`).
Change: add a `.catch` capturing the message into a local ref, rendered near the Start implementation/Start phase controls, mirroring the `sessionError` pattern already used in McpView.vue and DiffView.vue.
Risk: none; purely additive.

### Worth doing

- **Two sessions needing the same never-built sandbox image race into duplicate `docker build` runs.** `docker-sandbox.ts:452-494` has no in-flight de-duplication by image tag, unlike `probingModels` in `session-manager.ts:490-504`, which already solves the identical problem with a cached promise. Apply the same `Map<string, Promise<void>>` pattern. Risk: none beyond clearing the map entry on a failed build so retries can rebuild.

- **A hard `docker run` failure is captured but only logged to the main-process console.** `docker-sandbox.ts:683-699` captures `stderrTail` but only `console.error`s it; the vendored SDK's own stderr-tracking is bypassed entirely for a custom `spawnClaudeCodeProcess`, so a sandbox-level failure (bad mount, name conflict, invalid memory setting) surfaces only a bare exit code to the developer. Change: thread `stderrTail` into the string that reaches `explainExit`'s `raw` output, reusing the existing truncation pattern. Risk: low.

- **`specs.runInSession` has no way to target the session the developer is actually looking at.** The IPC request (`ipc-types.ts:408-411`) carries no `sessionId`; the handler falls back to `activeForProject` (newest-started live session), while the sidebar's focused session can be a different, older one. Change: add an optional `sessionId` field, preferred over the fallback, additive and backward compatible.

- **`command_history` has no retention policy**, unlike `verify_runs`/`api_runs`, which are already bounded via `pruneToLast` on insert. Unbounded growth also makes the composer's `recent()` `GROUP BY text` scan cost grow with the project's entire lifetime. Change: apply the same `pruneToLast` pattern. Risk: trivial.

- **Regenerating a diagram under the same file name leaves a stale plan attached.** `repositories.ts:1262-1273`'s `ON CONFLICT` branch updates `sessionId`/`description`/`createdAt` but not `plan`, so a retry before the prior generation reports can show the wrong plan strip. Change: set `plan = NULL` on conflict; already nullable and already rendered as an empty state.

- **A single throwing listener silently drops the rest of a `push.event` batch.** `src/preload/index.ts:54-59` has no per-item try/catch in the dispatch loop; one bad event permanently desyncs the live view until a manual reload, since events are append-only with no re-fetch trigger. Change: wrap each dispatch in its own try/catch.

- **A multi-question `AskUserQuestion` fires one desktop notification per question instead of one per tool call.** `permission-broker.ts:606-629` calls `onNeedsYou` once per array entry. Change: raise it once per `handleQuestion` call.

- **The status bar's interrupt hint is keyed to any project's session, not the one open.** `StatusBar.vue:29-31`'s `anyWorking` scans every project; Ctrl+C only ever acts on the currently open session. Change: base the hint on the open session's own status.

- **Sidebar's per-row pending-count lookup is an uncached scan its sibling was fixed to avoid.** `Sidebar.vue:211-213`'s `pendingFor` re-scans `inbox.pending` on every render, driven by a per-second timer, in the same file where `statusById` was already turned into a cached `computed()` for exactly this cost. Change: add a `pendingByProject` computed alongside it.

- **History never records which of the three auto-approval paths actually fired.** `permission-broker.ts:203-207` collapses standing rule, cwd auto-approve, and risk-setting auto-approve into one boolean before the request is built; `domain.ts:35` has only one `rule_approved` status. Change: carry the matched cause through to the stored request. Effort M; touches domain type, repository, IPC and renderer.

- **No exportable report for a verification run**, only for the API eval set (`handlers.ts:803-835`, `apiReportMarkdown`). Change: add `verifyReportMarkdown`/`verify.report` mirroring the existing `api.report`, with a "Write test report" button next to "Capture evidence".

- **Cobertura's per-file coverage is read then thrown away.** `artefacts.ts` (per-file section referenced at the reviewed lines) extracts only the whole-run `line-rate`, never the per-`<class>` rates, so the Coverage panel's "worst-covered touched files" row stays an unverified model claim forever. Change: extend the parser to return per-file rates and reconcile them the same way whole-run figures already are; fall back to leaving the session's list alone on a filename mismatch.

- **Adding an MCP-answered suite to the small-change eval loop produces a nonsensical check prompt.** `EvalsView.vue`'s `addFromSuite` (lines 74-77) does not carry the `mcp` flag that `verify-dispatch.ts:279-283` already uses to phrase MCP suites correctly; `eval-dispatch.ts:16-26` always frames the prompt as a shell command with an exit-code pass condition. Change: either pass the `mcp` flag through so `checkPrompt` can branch the same way, or disable those two suites in the "add from suite" shortcut and point at the Quality panel instead.

- **Diff tab gives no feedback that an applied region-edit is happening or landed.** `diff.ts:79` captures `appliedSessionId` but `DiffView.vue` never reads it, and the turn-complete watcher (`SessionView.vue:491-501`) refreshes the file list but never the already-open file's diff. Change: render a `MiniTerminal` keyed to `appliedSessionId` (the pattern Cleanup/Diagrams already use), and re-invoke `diff.selectFile` on turn-complete when a path is open.

- **`installSpecKit` surfaces a raw ENOENT instead of an actionable message when `uvx` is missing.** `spec-kit.ts:231-258` falls through to Node's own error string, unlike the sibling `plugin-install.ts:77-85`, which already gives an actionable message for a missing CLI. Change: detect the missing-executable case and name `uv`/its install URL. Must branch on platform: `spec-kit.ts:249` runs with `shell: true` on Windows, so the failure there is a "not recognized" stderr string, not a bare ENOENT.

- **UP NEXT queue can be added to, edited, or removed from, but never reordered.** `TaskQueueRepo` (`repositories.ts:734-758`) has no swap/reorder method; correcting order today means delete-and-retype. Effort M: add a `queue.reorder`/`moveUp`/`moveDown` call swapping adjacent `position` values (no uniqueness constraint on the column, so a swap is race-safe) plus up/down affordances on each chip.

- **Cleanup/Diagrams "not installed in this project" copy misdescribes a host-wide install.** `plugin-install.ts:96` installs with `--scope user` (account-wide), but `CleanupView.vue:146` and `DiagramsView.vue:207-209` both phrase it as project-scoped, unlike SpecsView's genuinely accurate project-local copy for Spec Kit. Change (safe half only): reword both cards to state the install is account-wide. The deeper option, a project-scoped install visible inside containers, overlaps with the Cleanup-routing fix above and should be scoped separately if pursued.

### Consider later (accessibility polish, cosmetic, low traffic)

- **Raw view's "result" line drops the duration/cost/token count it actually carries.** `stream-lines.ts:51-52` emits only "turn complete" where `StreamEvent.vue:103-112`'s `resultLabel` builds the full suffix from the same payload. Extend the raw case to match, and update `stream-lines.spec.ts:24`'s pinned string.
- **Swallowed-block toggle no longer shows the line count** its own header comment describes (`SwallowedBlock.vue:3-4` vs `:28-30`). Add `events.length` back into the label; update `clean-view.spec.ts:28`.
- **Several "click to expand/reveal more" controls are bare `<div>`s with no keyboard path**: `SwallowedBlock.vue:28`, `SessionView.vue:1667-1671,1734-1738`, versus the working `<button>` pattern three lines above each. Convert to `<button type="button">` or add `role`/`tabindex`/keydown handling.
- **Composer's slash-command dropdown has no listbox/option ARIA**, unlike the session-start mode picker in the same file (`SessionView.vue:1903-1916` vs `:1501-1516`). Add `role="listbox"`/`role="option"`/`aria-selected`/`aria-activedescendant`.
- **Copying a fenced code block has no keyboard path.** `MarkdownText.vue:60-90`'s `copyBlock` is click-only by design (to preserve `v-html`'s fixed, attribute-free tag set). Add a shared, non-identifying `tabindex="0"` on `pre.md-pre` and a keydown handler beside the existing click handler.

## 3. Rejected proposals

- **Per-session Docker volumes accumulate forever with no cleanup.** Rejected: contradicts an existing, dated decision already in the code. `docker-sandbox.ts:92-94` states directly that volumes are fine to accumulate at today's usage and that a sweep should be added "once disk use actually shows it." No such evidence exists yet.
- **`resolveClaudeExecutable` only checks one fixed path, with no fallback for a non-default install location.** Rejected as not worth it. The module's own header comment explains the fixed path is trusted specifically because the native installer guarantees a real, crash-safe binary there; a PATH-resolved `claude` could be a shim, reintroducing the exact V8-snapshot crash `pathToClaudeCodeExecutable` was added to prevent. A clearer error message pointing at the expected location is the lower-risk way to help the affected developer.
- **Parallel-subagent rows only appear on the selected project, not every project.** Rejected as not worth it. This is a known, named shortcut (`Sidebar.vue:31-32`'s own `ponytail:` comment), and the product's stated core need is spotting which project is blocked, a signal already visible via the existing status glyph on every row. Not worth the multi-call-site change for an unconfirmed secondary nicety.

## 4. Coverage: what was not read

- **Sessions area:** no gaps stated by the reviewing pass.
- **IPC/store area:** read in full: `ipc-types.ts`, `handlers.ts`, `db.ts`, `repositories.ts`, `retention.ts`, `prune-cli.ts`, `preload/index.ts`, `projects/discovery.ts`, `shared/diagram.ts`, plus `CLAUDE.md`, `PRODUCT.md`, `DESIGN.md` and the electron-audit conventions doc. Only excerpts of `session-manager.ts` were read (the parts called from `handlers.ts`/`repositories.ts`). Not read: `main/inbox/` (`permission-broker.ts`, `rule-prefs.ts`), `main/evals/*`, `main/mcp/schema-doc.ts`, `main/specs/spec-kit.ts`, `main/updater.ts`, `main/sessions/docker-sandbox.ts`, `main/sessions/plugin-install.ts`, any renderer store or component beyond the cited grep hits and one `SessionView.vue` excerpt, and no test files. Which of these gaps already have a regression test guarding the opposite behaviour is unknown.
- **Shell area:** no gaps stated by the reviewing pass.
- **Session-view area:** no gaps stated by the reviewing pass.
- **Verification area:** read in full: `test-catalog.ts`, `api-endpoints.ts`, `api-report.ts` (skimmed), all of `main/evals/*`, the eval/verify/api section of `handlers.ts`, the verify/api/eval watch logic in `session-manager.ts`, `TestsView.vue`, the first ~250 lines of `EvalsView.vue`, `useVerifyGates.ts`, `useApiEvalSet.ts`, `stores/verify.ts`, `stores/api.ts`, and the eval/verify domain types in `domain.ts`. Not read: the back half of `EvalsView.vue` (rating/attempts UI past line 250) and its style block, `db.ts` migrations, `docker-sandbox.ts`, `session-shaping.ts`, `permission-broker.ts`/`standing-rules.ts`, `tests/unit` and `tests/e2e` for this area, and the `EvalsRepo` implementation beyond its signatures.
- **Work-sections area (Specs, Diff, Cleanup, Diagrams, MCP):** read in full every file named in the brief, plus `session-manager.ts`'s diff/numstat/background-session/`onCommands` logic, `docker-sandbox.ts` in full, `plugin-install.ts` in full, `command-catalog.ts`, `mcp-combo.ts`, `MiniTerminal.vue`, and the relevant slices of `SessionView.vue`. Not read: `main/store/repositories.ts`/`db.ts` beyond confirming their existence, the settings store beyond MCP-toggle methods, the projects store, the `activeSession` store, and the e2e/unit test suites beyond targeted greps for diff/rename coverage. The staged-change and staged-rename git behaviour was verified empirically against a real git 2.53 checkout rather than asserted from memory.

No file in `tests/unit` or `tests/e2e` was read in full across any area; whether a given finding already has a failing or passing test is unconfirmed unless stated otherwise above.
