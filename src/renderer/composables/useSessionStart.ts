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
  const startError = ref<string | null>(null)
  const resumeFailed = ref(false)

  const canResume = computed(() => {
    const previous = endedSession()
    return (
      !resumeFailed.value &&
      !!previous?.sdkSessionId &&
      (previous.engine ?? DEFAULT_SESSION_ENGINE) === startEngine.value
    )
  })

  const lastTranscript = computed(() => {
    const id = endedSession()?.id
    const transcript = id ? transcripts.bySession[id] : null
    return transcript && transcript.prompts > 0 ? transcript : null
  })

  const continueHow = computed<'resume' | 'carry' | null>(() => {
    if (canResume.value) return 'resume'
    if (startEngine.value === 'claude' && lastTranscript.value !== null) return 'carry'
    return null
  })
  const canContinue = computed(() => continueHow.value !== null)
  const resuming = computed(() => resumeSession.value && continueHow.value === 'resume')
  const carrying = computed(() => resumeSession.value && continueHow.value === 'carry')

  const containerForced = computed(() => startMode.value === 'bypass' || resuming.value)
  const containerOn = computed(
    () =>
      startEngine.value === 'claude' &&
      (resuming.value
        ? endedSession()?.containerised === true
        : startMode.value === 'bypass' || runInContainer.value),
  )

  const modeChoices = computed(() => {
    const onHost = startEngine.value === 'codex' || (resuming.value && !endedSession()?.containerised)
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
    resumeFailed.value = false
    startMode.value = project().defaultSessionMode ?? DEFAULT_SESSION_MODE
    startEngine.value = defaultEngine()
  }

  watch(
    () => endedSession()?.id ?? null,
    (id) => {
      resumeFailed.value = false
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

  watch(canContinue, (possible) => {
    if (!possible) resumeSession.value = false
  })

  function resumeDidNotWork(reason: string): void {
    resumeFailed.value = true
    resumeSession.value = false
    const fallback =
      continueHow.value === 'carry'
        ? ' Turn Continue from last session back on to carry its transcript instead.'
        : ''
    startError.value = `Resume failed, starting fresh — ${reason}${fallback}`
  }

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
        if (wasResuming) resumeDidNotWork(reason)
        else startError.value = reason
      },
      { immediate: true },
    )
    pendingCrashWatches.push(stop)
  }

  async function start(): Promise<void> {
    const target = project().id
    const wasResuming = resuming.value
    const carryFrom = carrying.value ? lastTranscript.value?.sessionId : undefined
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
        carryFrom,
        wasResuming ? previous?.id : undefined,
      )
      watchForImmediateCrash(target, session.id, wasResuming)
    } catch (e) {
      if (project().id === target) {
        const message = isIpcError(e) ? e.message : String(e)
        if (wasResuming) resumeDidNotWork(message)
        else startError.value = message
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
    canContinue,
    continueHow,
    resuming,
    carrying,
    lastTranscript,
    busy,
    start,
    reset,
  }
}
