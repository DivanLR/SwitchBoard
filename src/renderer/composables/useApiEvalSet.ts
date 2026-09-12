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
  const apiTarget = ref<ApiTarget>('local')

  const apiRun = computed(() => api.latestFor(projectId()))
  const apiRunning = computed(() => apiRun.value?.status === 'running')
  const apiHost = computed(() => api.hostFor(projectId()))
  const apiQa = computed(() => api.qaFor(projectId()))
  const apiScan = computed(() => api.scan[projectId()] ?? null)

  const apiShortlist = computed<Endpoint[]>(() => {
    const recent = api.recentFor(projectId())
    return recent.length > 0 ? recent : api.endpointsFor(projectId()).slice(0, 5)
  })

  const apiMatches = computed<DiscoveredEndpoint[]>(() =>
    searchEndpoints(api.endpointsFor(projectId()), search.value),
  )

  const apiFoundCount = computed(() => api.endpointsFor(projectId()).length)

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
