import { computed, onUnmounted, ref, toValue, watch, type MaybeRefOrGetter } from 'vue'
import { DEFAULT_SESSION_ENGINE, DEFAULT_SESSION_MODE, SESSION_MODES } from '@shared/domain'
import type { Session, SessionEngine, SessionMode } from '@shared/domain'
import { isIpcError, type ProjectListItem } from '@shared/ipc-types'
import { useProjectsStore } from '@renderer/stores/projects'
import { useSettingsStore } from '@renderer/stores/settings'
import { useTerminalStore } from '@renderer/stores/terminal'
import { useTranscriptsStore } from '@renderer/stores/transcripts'

export function useSessionStart(opts: {
  project: MaybeRefOrGetter<ProjectListItem>
  endedSession: MaybeRefOrGetter<Session | null>
}) {
  const projects = useProjectsStore()
  const settings = useSettingsStore()
  const terminals = useTerminalStore()
  const transcripts = useTranscriptsStore()
  const defaultEngine = (): SessionEngine => settings.settings?.defaultEngine ?? DEFAULT_SESSION_ENGINE
  const project = (): ProjectListItem => toValue(opts.project)
  const endedSession = (): Session | null => toValue(opts.endedSession)

  const busy = ref(false)
  const startMode = ref<SessionMode>(project().defaultSessionMode ?? DEFAULT_SESSION_MODE)
  const modeOpen = ref(false)
  const resumeSession = ref(false)
  const startEngine = ref<SessionEngine>(defaultEngine())

  const runInContainer = computed({
    get: () => project().useContainers,
    set: (on: boolean) => {
      void projects.setUseContainers(project().id, on)
    },
  })
  const containerForced = computed(() => startMode.value === 'bypass' || resumeSession.value)
  const containerOn = computed(
    () =>
      startEngine.value === 'claude' &&
      (resumeSession.value
        ? endedSession()?.containerised === true
        : startMode.value === 'bypass' || runInContainer.value),
  )
  const startError = ref<string | null>(null)

  const canResume = computed(() => {
    const previous = endedSession()
    return !!previous?.sdkSessionId && (previous.engine ?? DEFAULT_SESSION_ENGINE) === startEngine.value
  })

  const carryTranscript = ref(false)
  const lastTranscript = computed(() => {
    const id = endedSession()?.id
    const transcript = id ? transcripts.bySession[id] : null
    return transcript && transcript.prompts > 0 ? transcript : null
  })
  const canCarry = computed(
    () => startEngine.value === 'claude' && !resumeSession.value && lastTranscript.value !== null,
  )

  const modeChoices = computed(() => {
    const onHost =
      startEngine.value === 'codex' || (resumeSession.value && !endedSession()?.containerised)
    return onHost ? SESSION_MODES.filter((m) => m.value !== 'bypass') : SESSION_MODES
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
    carryTranscript.value = false
    startMode.value = project().defaultSessionMode ?? DEFAULT_SESSION_MODE
    startEngine.value = defaultEngine()
  }

  watch(
    () => endedSession()?.id ?? null,
    (id) => {
      carryTranscript.value = false
      if (!id) return
      void transcripts.load(id).catch(() => {})
      const previous = endedSession()
      startMode.value = previous?.bypassPermissions
        ? 'bypass'
        : previous?.planMode
          ? 'plan'
          : (project().defaultSessionMode ?? DEFAULT_SESSION_MODE)
      startEngine.value = previous?.engine ?? defaultEngine()
    },
    { immediate: true },
  )

  watch(canResume, (possible) => {
    if (!possible) resumeSession.value = false
  })

  watch(
    [startMode, modeChoices],
    () => {
      if (!modeChoices.value.some((m) => m.value === startMode.value)) {
        startMode.value = modeChoices.value[0]?.value ?? DEFAULT_SESSION_MODE
      }
    },
    { immediate: true },
  )

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
        startEngine.value,
        canCarry.value && carryTranscript.value ? lastTranscript.value?.sessionId : undefined,
        wasResuming ? previous?.id : undefined,
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
    carryTranscript,
    lastTranscript,
    canCarry,
    busy,
    start,
    reset,
  }
}
