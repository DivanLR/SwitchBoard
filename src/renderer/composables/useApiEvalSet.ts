// The API eval set: which endpoints are picked, where the calls go, and running
// them. Extracted from TestsView so the view is left rendering panels.
//
// This is the deterministic path, and the reason the panel exists: the endpoints
// come from a scan of the project's own source, the calls are made by the app,
// and pass or fail is computed from the status that came back. The session is
// asked for one thing only — identifiers that really exist — and nothing it says
// decides a verdict.
import { computed, ref, toValue, watch, type MaybeRefOrGetter } from 'vue'
import type { ApiTarget, DiscoveredEndpoint } from '@shared/api-endpoints'
import { searchEndpoints } from '@shared/api-endpoints'
import { useApiStore } from '@renderer/stores/api'

const api = useApiStore()

type Endpoint = { method: string; template: string }

const endpointKey = (e: Endpoint): string => `${e.method} ${e.template}`

export function useApiEvalSet(projectIdInput: MaybeRefOrGetter<string>) {
  const projectId = (): string => toValue(projectIdInput)

  const picked = ref<Endpoint[]>([])
  const search = ref('')
  const baseUrlField = ref('')
  const startCmdField = ref('')
  const qaUrlField = ref('')
  const qaHeadersField = ref('')
  /** Which environment the next run goes to. Local by default, always: a
   *  deployed environment is a deliberate choice, never one made for them. */
  const apiTarget = ref<ApiTarget>('local')

  const apiRun = computed(() => api.latestFor(projectId()))
  const apiRunning = computed(() => apiRun.value?.status === 'running')
  const apiHost = computed(() => api.hostFor(projectId()))
  const apiQa = computed(() => api.qaFor(projectId()))
  const apiScan = computed(() => api.scan[projectId()] ?? null)

  /** The last five endpoints actually tested — or, before anything has run, the
   *  first few the scan found, so the panel is never an empty search box. */
  const apiShortlist = computed<Endpoint[]>(() => {
    const recent = api.recentFor(projectId())
    return recent.length > 0 ? recent : api.endpointsFor(projectId()).slice(0, 5)
  })

  const apiMatches = computed<DiscoveredEndpoint[]>(() =>
    searchEndpoints(api.endpointsFor(projectId()), search.value),
  )

  const apiFoundCount = computed(() => api.endpointsFor(projectId()).length)

  /** Where the base URL came from, or why there is none. */
  const apiHostLine = computed(
    () =>
      apiHost.value?.error ??
      (apiHost.value?.from
        ? `from ${apiHost.value.from} · started only if nothing answers there`
        : ''),
  )

  const apiQaLine = computed(
    () =>
      apiQa.value?.error ??
      'A QA header value written as ${VAR} is read from the environment when the call is made — the key itself is never stored here or written into a report.',
  )

  const isPicked = (e: Endpoint): boolean =>
    picked.value.some((p) => endpointKey(p) === endpointKey(e))

  function togglePick(e: Endpoint): void {
    picked.value = isPicked(e)
      ? picked.value.filter((p) => endpointKey(p) !== endpointKey(e))
      : [...picked.value, { method: e.method, template: e.template }]
  }

  // The fields show what a run would use right now, resolved or overridden, so
  // saving pins exactly what is on screen rather than something implied.
  watch(
    apiHost,
    (host) => {
      baseUrlField.value = host?.baseUrl ?? ''
      startCmdField.value = host?.startCmd ?? ''
    },
    { immediate: true },
  )

  watch(
    apiQa,
    (qa) => {
      qaUrlField.value = qa?.baseUrl ?? ''
      qaHeadersField.value = qa?.headers ?? ''
    },
    { immediate: true },
  )

  /** No QA URL means no QA choice: the chip is not offered until there is one. */
  const qaReady = computed(() => !!apiQa.value?.baseUrl)

  watch(qaReady, (ready) => {
    if (!ready) apiTarget.value = 'local'
  })

  async function saveApiHost(): Promise<void> {
    await api.setHost(projectId(), {
      baseUrl: baseUrlField.value,
      startCmd: startCmdField.value,
      qaBaseUrl: qaUrlField.value,
      qaHeaders: qaHeadersField.value,
    })
  }

  async function runApi(): Promise<void> {
    if (picked.value.length === 0) return
    await api.start(projectId(), picked.value, apiTarget.value)
  }

  async function writeApiReport(): Promise<void> {
    await api.writeReport(projectId(), apiRun.value?.id)
  }

  const apiSummary = computed(() => {
    const run = apiRun.value
    if (!run) return 'No API eval set yet.'
    const when = new Date(run.startedAt).toLocaleString()
    const where = run.target === 'qa' ? ' · QA' : ''
    if (run.status === 'running') return `Running since ${when}${where}`
    const passed = run.calls.filter((c) => c.outcome === 'pass').length
    return `${when}${where} · ${passed}/${run.calls.length} calls passed · ${run.baseUrl}`
  })

  return {
    picked,
    search,
    baseUrlField,
    startCmdField,
    qaUrlField,
    qaHeadersField,
    apiTarget,
    apiRun,
    apiRunning,
    apiScan,
    apiShortlist,
    apiMatches,
    apiFoundCount,
    apiHostLine,
    apiQaLine,
    qaReady,
    isPicked,
    togglePick,
    saveApiHost,
    runApi,
    writeApiReport,
    apiSummary,
  }
}
