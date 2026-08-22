// The ended-session start controls: WHICH mode the next session runs in, and
// WHETHER it picks up the last conversation, plus the button that actually
// starts it and the watch that catches a start dying moments later. Extracted
// from SessionView so the view stays focused on rendering the stream.
//
// Two switches, where there used to be two buttons and three: the three could
// describe states the SDK cannot spawn in (plan and bypass both on meant one
// silently won), and they only ever offered two of the six modes the SDK
// actually has.
import { computed, onUnmounted, ref, toValue, watch, type MaybeRefOrGetter } from 'vue'
import { DEFAULT_SESSION_MODE, SESSION_MODES } from '@shared/domain'
import type { Session, SessionMode } from '@shared/domain'
import { isIpcError, type ProjectListItem } from '@shared/ipc-types'
import { useProjectsStore } from '@renderer/stores/projects'

export function useSessionStart(opts: {
  project: MaybeRefOrGetter<ProjectListItem>
  endedSession: MaybeRefOrGetter<Session | null>
}) {
  const projects = useProjectsStore()
  const project = (): ProjectListItem => toValue(opts.project)
  const endedSession = (): Session | null => toValue(opts.endedSession)

  const busy = ref(false)
  // Seeded from the CURRENT project's own default rather than the bare constant:
  // the caller's project watcher (which used to perform this same assignment)
  // cannot reach `reset()` on this instance's own construction — see the note on
  // `reset` below — so the initial value has to be right on its own, for the
  // common case of mounting on a project with no ended session to prefill from.
  const startMode = ref<SessionMode>(project().defaultSessionMode ?? DEFAULT_SESSION_MODE)
  const modeOpen = ref(false)
  /** Resume the previous conversation rather than starting an empty one. */
  const resumeSession = ref(false)

  /**
   * WHERE the next session runs: a container, or this machine.
   *
   * Its own switch because it is its own question. Bypass has always forced a
   * container (on Windows there is no other isolation boundary) and that stays
   * true, so the switch reads as on and locked in that mode rather than quietly
   * disagreeing with what is about to happen.
   *
   * The PROJECT holds the answer, not this composable. It used to be a local
   * ref that reset to false on every mount, which meant the same question was
   * asked in two places with two answers: this switch for a chat session, and a
   * hard-coded true for every section dispatch. One switch, one stored fact
   * (Project.useContainers), and the checkbox in the header writes the same one.
   */
  const runInContainer = computed({
    get: () => project().useContainers,
    set: (on: boolean) => {
      void projects.setUseContainers(project().id, on)
    },
  })
  const containerForced = computed(() => startMode.value === 'bypass')
  const containerOn = computed(() => containerForced.value || runInContainer.value)
  /** Session-start failure (e.g. wslc missing for a bypass session), ended banner. */
  const startError = ref<string | null>(null)

  const canResume = computed(() => Boolean(endedSession()?.sdkSessionId))

  /**
   * The modes a start may pick right now. Everything, until Resume is on: a bypass
   * session's transcript lives in that project's container volume rather than in
   * the host's ~/.claude, so resuming one as a native session looks in the wrong
   * place and silently finds nothing (and the reverse). Rather than let the
   * developer choose a pair that cannot work, the impossible half is not offered.
   */
  const modeChoices = computed(() => {
    if (!resumeSession.value) return SESSION_MODES
    const wasBypass = endedSession()?.bypassPermissions === true
    return SESSION_MODES.filter((m) => (m.value === 'bypass') === wasBypass)
  })

  const startModeLabel = computed(
    () => SESSION_MODES.find((m) => m.value === startMode.value)?.label ?? 'Default',
  )
  const startModeDetail = computed(
    () => SESSION_MODES.find((m) => m.value === startMode.value)?.detail ?? '',
  )

  /**
   * Per-project reset: called by the caller's own project-switch watcher. A
   * start failure from the project we left must not read as this one's, and a
   * chosen mode must never carry over and silently start the NEXT project's
   * session with permissions skipped.
   *
   * The caller holds its reference to this composable in a `let` assigned AFTER
   * its project watcher is declared (see the comment beside that watcher), so on
   * this component's very first mount the watcher's immediate run calls `reset`
   * before this instance exists and it is a harmless no-op — the ref initialisers
   * above already put every field in the state `reset` would have produced. Every
   * later project switch, the instance exists and this genuinely runs.
   */
  function reset(): void {
    startError.value = null
    busy.value = false
    modeOpen.value = false
    resumeSession.value = false
    startMode.value = project().defaultSessionMode ?? DEFAULT_SESSION_MODE
  }

  // The picker opens on however the last session began — not on where it ended up.
  // A session toggled out of plan mode mid-flight still STARTED as one, and
  // offering that again is the choice the developer actually made.
  //
  // ORDERING: the caller (SessionView.vue) constructs this composable AFTER its
  // own project-switch watcher, which calls `reset()`, so that THIS watcher —
  // registered second — runs second too and its assignment is the one that
  // sticks on a project switch. Vue schedules same-tick watchers in registration
  // order; reversing the construction order here would reverse which one wins,
  // silently.
  watch(
    () => endedSession()?.id ?? null,
    (id) => {
      if (!id) return
      const previous = endedSession()
      startMode.value = previous?.bypassPermissions
        ? 'bypass'
        : previous?.planMode
          ? 'plan'
          : (project().defaultSessionMode ?? DEFAULT_SESSION_MODE)
    },
    { immediate: true },
  )

  /** Turning Resume on can rule out the mode already picked; move off it. */
  watch([resumeSession, modeChoices], () => {
    if (!modeChoices.value.some((m) => m.value === startMode.value)) {
      startMode.value = modeChoices.value[0]?.value ?? DEFAULT_SESSION_MODE
    }
  })

  /** Crash watches still waiting on a row when the view unmounts. Each stops
   *  itself once its row settles; this only covers the ones that never did. */
  const pendingCrashWatches: (() => void)[] = []
  // Owned here, not by the caller: the array is this composable's own internal
  // bookkeeping, so the composable is the one that must drain it rather than
  // handing the raw array out for someone else to remember to clean up.
  onUnmounted(() => {
    for (const stop of pendingCrashWatches.splice(0)) stop()
  })

  /**
   * `sessions.start` resolves as soon as the CLI process is spawned; the run
   * loop that actually proves it can run is async and un-awaited, so a start
   * that dies immediately (most often an invalid resume — a bypass session's
   * transcript lives in that project's container volume, so rebuilding the
   * sandbox image orphans it) reports success here and only shows up later as
   * an ended row, with the reason sitting in the banner's small detail line.
   *
   * Watches that one row (looked up through the store, not the caller's current
   * project — the developer may have switched away from `projectId` while it was
   * still spawning) and promotes a crash to the same start error a synchronous
   * failure gets, and turns Resume back off so a failed resume cannot silently
   * re-arm the next click.
   */
  function watchForImmediateCrash(projectId: string, sessionId: string, wasResuming: boolean): void {
    const found = computed(
      () => projects.items.find((p) => p.id === projectId)?.sessions.find((s) => s.id === sessionId) ?? null,
    )
    const stop = watch(
      found,
      (session) => {
        if (!session?.endedAt) return
        stop() // this row is settled either way — nothing more to watch for
        if (session.endReason !== 'crashed' || project().id !== projectId) return
        const reason = session.statusDetail ?? 'The session ended immediately after starting.'
        startError.value = wasResuming ? `Resume failed, starting fresh — ${reason}` : reason
        if (wasResuming) resumeSession.value = false
      },
      { immediate: true },
    )
    pendingCrashWatches.push(stop)
  }

  async function start(): Promise<void> {
    // This view is reused across projects and a bypass start can take minutes
    // (first-run image build), so the call is pinned to the project it was made
    // for — otherwise its result lands on whichever project is on screen when it
    // finally settles.
    const target = project().id
    const wasResuming = resumeSession.value && canResume.value
    busy.value = true
    startError.value = null
    modeOpen.value = false
    try {
      const session = await projects.startSession(
        target,
        // Resume only claims to resume when there is something to resume from.
        wasResuming,
        // The picker always sends a concrete mode. It opens on the project's own
        // default, so sending it explicitly changes nothing until it is changed.
        startMode.value,
        undefined,
        runInContainer.value,
      )
      // sessions.start resolves once the CLI is spawned, not once it has proven
      // it can run — watch the row it returned for the crash that would otherwise
      // surface only as a beat-later ended banner, easy to miss.
      watchForImmediateCrash(target, session.id, wasResuming)
    } catch (e) {
      // wslc missing or the host not logged in (bypass sessions run containerised)
      // — show it in the ended banner instead of dying as an unhandled rejection.
      if (project().id === target) {
        const message = isIpcError(e) ? e.message : String(e)
        // A resume attempt that failed must not stay armed for the next click —
        // retrying it unchanged would only fail the same way again.
        startError.value = wasResuming ? `Resume failed, starting fresh — ${message}` : message
        if (wasResuming) resumeSession.value = false
      }
    } finally {
      if (project().id === target) busy.value = false
    }
  }

  return {
    startMode,
    modeOpen,
    resumeSession,
    runInContainer,
    containerForced,
    containerOn,
    startError,
    modeChoices,
    startModeLabel,
    startModeDetail,
    canResume,
    busy,
    start,
    reset,
  }
}
