import { computed, onUnmounted, ref, toValue, watch, type MaybeRefOrGetter } from 'vue'
import { DEFAULT_SESSION_ENGINE, DEFAULT_SESSION_MODE, SESSION_MODES } from '@shared/domain'
import type { Session, SessionEngine, SessionMode } from '@shared/domain'
import { isIpcError, type ProjectListItem } from '@shared/ipc-types'
import { useProjectsStore } from '@renderer/stores/projects'
import { useSettingsStore } from '@renderer/stores/settings'

export function useSessionStart(opts: {
  project: MaybeRefOrGetter<ProjectListItem>
  endedSession: MaybeRefOrGetter<Session | null>
}) {
  const projects = useProjectsStore()
  const settings = useSettingsStore()
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
  const startEngine = ref<SessionEngine>(
    settings.settings?.defaultEngine ?? DEFAULT_SESSION_ENGINE,
  )
  const containerForced = computed(
    () => startMode.value === 'bypass' && startEngine.value === 'claude',
  )
  const containerOn = computed(
    () => startEngine.value === 'claude' && (containerForced.value || runInContainer.value),
  )
  const engineModes = computed(() =>
    startEngine.value === 'codex' ? SESSION_MODES.filter((m) => m.value !== 'bypass') : SESSION_MODES,
  )
  const startError = ref<string | null>(null)

  const canResume = computed(() => {
    const previous = endedSession()
    if (!previous?.sdkSessionId) return false
    return (previous.engine ?? DEFAULT_SESSION_ENGINE) === startEngine.value
  })

  const modeChoices = computed(() => {
    if (!resumeSession.value) return engineModes.value
    const wasBypass = endedSession()?.bypassPermissions === true
    return engineModes.value.filter((m) => (m.value === 'bypass') === wasBypass)
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
    startEngine.value = settings.settings?.defaultEngine ?? DEFAULT_SESSION_ENGINE
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
      startEngine.value = previous?.engine ?? settings.settings?.defaultEngine ?? DEFAULT_SESSION_ENGINE
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
      const session = await projects.startSession(
        target,
        wasResuming,
        startMode.value,
        undefined,
        containerOn.value,
        startEngine.value,
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
    startEngine,
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
