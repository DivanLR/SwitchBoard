import { computed, onUnmounted, ref, toValue, watch, type MaybeRefOrGetter } from 'vue'
import { DEFAULT_SESSION_MODE, SESSION_MODES } from '@shared/domain'
import type { Session, SessionMode } from '@shared/domain'
import { isIpcError, type ProjectListItem } from '@shared/ipc-types'
import { useProjectsStore } from '@renderer/stores/projects'
import { useTerminalStore } from '@renderer/stores/terminal'

export function useSessionStart(opts: {
  project: MaybeRefOrGetter<ProjectListItem>
  endedSession: MaybeRefOrGetter<Session | null>
}) {
  const projects = useProjectsStore()
  const terminals = useTerminalStore()
  const project = (): ProjectListItem => toValue(opts.project)
  const endedSession = (): Session | null => toValue(opts.endedSession)

  const busy = ref(false)
  const startMode = ref<SessionMode>(project().defaultSessionMode ?? DEFAULT_SESSION_MODE)
  const modeOpen = ref(false)
  const resumeSession = ref(false)

  const runInContainer = computed({
    get: () => project().useContainers,
    set: (on: boolean) => {
      void projects.setUseContainers(project().id, on)
    },
  })
  const containerForced = computed(() => startMode.value === 'bypass')
  const containerOn = computed(() => containerForced.value || runInContainer.value)
  const startError = ref<string | null>(null)

  const canResume = computed(() => !!endedSession()?.sdkSessionId)

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

  function reset(): void {
    startError.value = null
    busy.value = false
    modeOpen.value = false
    resumeSession.value = false
    startMode.value = project().defaultSessionMode ?? DEFAULT_SESSION_MODE
  }

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

  watch(canResume, (possible) => {
    if (!possible) resumeSession.value = false
  })

  watch([resumeSession, modeChoices], () => {
    if (!modeChoices.value.some((m) => m.value === startMode.value)) {
      startMode.value = modeChoices.value[0]?.value ?? DEFAULT_SESSION_MODE
    }
  })

  const pendingCrashWatches: (() => void)[] = []
  onUnmounted(() => {
    for (const stop of pendingCrashWatches.splice(0)) stop()
  })

  function watchForImmediateCrash(projectId: string, sessionId: string, wasResuming: boolean): void {
    const found = computed(
      () => projects.items.find((p) => p.id === projectId)?.sessions.find((s) => s.id === sessionId) ?? null,
    )
    const stop = watch(
      found,
      (session) => {
        if (!session?.endedAt) return
        stop() 
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
    const target = project().id
    const wasResuming = resumeSession.value && canResume.value
    busy.value = true
    startError.value = null
    modeOpen.value = false
    try {
      const previous = endedSession()
      if (wasResuming && previous) await terminals.close(previous.id).catch(() => {})
      const session = await projects.startSession(
        target,
        wasResuming,
        startMode.value,
        containerOn.value,
      )
      watchForImmediateCrash(target, session.id, wasResuming)
    } catch (e) {
      if (project().id === target) {
        const message = isIpcError(e) ? e.message : String(e)
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
