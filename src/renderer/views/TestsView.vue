<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  defaultSelection,
  sandboxNeedsDotnet,
  sandboxTools,
  stackById,
  suiteById,
  TEST_STACKS,
  unavailableReason,
  type SandboxEnv,
  type TestSuite,
} from '@shared/test-catalog'
import { estimateRunMs, humanDuration, type SuiteResult, type VerifyRun } from '@shared/domain'
import { type ApiExpect } from '@shared/api-endpoints'
import { useEvalsStore } from '@renderer/stores/evals'
import { useVerifyStore } from '@renderer/stores/verify'
import { useApiStore } from '@renderer/stores/api'
import { useProjectsStore } from '@renderer/stores/projects'
import MiniTerminal from '@renderer/components/MiniTerminal.vue'
import { useSettingsStore } from '@renderer/stores/settings'
import { useActiveSessionStore } from '@renderer/stores/activeSession'
import { useApiEvalSet } from '@renderer/composables/useApiEvalSet'
import { pct, round, sourceOf, unmeasured, useVerifyGates } from '@renderer/composables/useVerifyGates'
import EvalsView from '@renderer/views/EvalsView.vue'
import Icon from '@renderer/components/Icon.vue'

const props = defineProps<{ projectId: string; projectName: string; branch?: string | null }>()

const emit = defineEmits<{
  (e: 'ran'): void
  (e: 'run', text: string): void
}>()

const settingsStore = useSettingsStore()
const projectsStore = useProjectsStore()
const evals = useEvalsStore()
const verify = useVerifyStore()
const api = useApiStore()

type SubTab = 'api' | 'coverage' | 'quality' | 'evidence' | 'qa' | 'skill'
const subTab = ref<SubTab>('qa')
const selected = ref<string[] | null>(null)

let stopPush: (() => void) | null = null
let stopApiPush: (() => void) | null = null
onMounted(() => {
  void evals.load(props.projectId)
  void verify.load(props.projectId)
  void api.load(props.projectId)
  stopPush = window.switchboard.on('push.verifyChanged', (push) => {
    verify.applyPush(push.projectId, push.runs)
  })
  stopApiPush = window.switchboard.on('push.apiChanged', (push) => {
    api.applyPush(push.projectId, push.runs)
  })
})
onUnmounted(() => {
  stopPush?.()
  stopApiPush?.()
})
watch(
  () => props.projectId,
  (id) => {
    selected.value = null
    picked.value = []
    void evals.load(id)
    void verify.load(id)
    void api.load(id)
  },
)

const detected = computed(() => evals.suitesFor(props.projectId))
const chosenId = computed(() => settingsStore.settings?.projectTestStacks?.[props.projectId])
const stack = computed(() => stackById(chosenId.value))
const latest = computed(() => verify.latestFor(props.projectId))
const running = computed(() => latest.value?.status === 'running')

const sandboxed = computed<SandboxEnv>(() =>
  projectsStore.items.find((p) => p.id === props.projectId)?.session?.bypassPermissions === true
    ? sandboxTools(sandboxNeedsDotnet(detected.value))
    : null,
)

const suites = computed<TestSuite[]>(() => {
  const found = detected.value.find((d) => d.stackId === chosenId.value)
  const catalogue = [...(found?.suites ?? stack.value?.suites ?? [])]
  const overrides = commandOverrides.value
  return catalogue.map((suite) =>
    overrides[suite.id] ? { ...suite, command: overrides[suite.id] } : suite,
  )
})
const blockedReason = (suite: TestSuite): string | null => unavailableReason(suite, sandboxed.value)

function isQueuedRetry(row: {
  suite: TestSuite
  result: SuiteResult | null
  retrying: boolean
}): boolean {
  return !row.retrying && row.result?.status === 'fail' && isSelected(row.suite)
}

function chipTitle(row: {
  suite: TestSuite
  result: SuiteResult | null
  retrying: boolean
}): string {
  if (row.retrying) return `${row.suite.label} — running now\n\ncommand: ${row.suite.command}`
  const blocked = blockedReason(row.suite)
  if (blocked) return `${row.suite.label} — ${blocked}`
  if (!row.result) return row.suite.command
  const detail = row.result.detail ? `\n${row.result.detail}` : ''
  const verified = row.result.verified ? '\nchecked against the runner’s own report file' : ''
  return `${row.suite.label} — ${row.result.status}${detail}${verified}\n\ncommand: ${row.suite.command}`
}

const commandOverrides = computed<Record<string, string>>(
  () => settingsStore.settings?.projectSuiteCommands?.[props.projectId] ?? {},
)

const editingCommand = ref<string | null>(null)
const commandDraft = ref('')

function editCommand(suite: TestSuite): void {
  editingCommand.value = suite.id
  commandDraft.value = suite.command
}

function saveCommand(suite: TestSuite): void {
  editingCommand.value = null
  const all = settingsStore.settings?.projectSuiteCommands ?? {}
  const mine = { ...(all[props.projectId] ?? {}) }
  const typed = commandDraft.value.trim()
  const catalogue = detected.value
    .find((d) => d.stackId === chosenId.value)
    ?.suites.find((s) => s.id === suite.id)?.command ??
    stack.value?.suites.find((s) => s.id === suite.id)?.command
  if (!typed || typed === catalogue) delete mine[suite.id]
  else mine[suite.id] = typed
  void settingsStore.save({ projectSuiteCommands: { ...all, [props.projectId]: mine } })
}

const storedSelection = computed<string[] | null>(
  () => settingsStore.settings?.projectTestSelection?.[props.projectId] ?? null,
)

watch(
  [suites, sandboxed],
  ([list, sandbox]) => {
    if (list.length === 0) {
      selected.value = null
      return
    }
    if (selected.value === null) {
      const offered = new Set(list.map((suite) => suite.id))
      selected.value = storedSelection.value
        ? storedSelection.value.filter((id) => offered.has(id))
        : defaultSelection(list, sandbox)
      return
    }
    const offered = new Set(list.map((suite) => suite.id))
    const kept = selected.value.filter((id) => offered.has(id))
    if (kept.length !== selected.value.length) selected.value = kept
  },
  { immediate: true },
)

watch(selected, (ids) => {
  if (ids === null) return
  const current = settingsStore.settings?.projectTestSelection ?? {}
  void settingsStore.save({ projectTestSelection: { ...current, [props.projectId]: ids } })
})

function toggleSuite(suite: TestSuite): void {
  if (blockedReason(suite)) return
  const current = selected.value ?? []
  selected.value = current.includes(suite.id)
    ? current.filter((id) => id !== suite.id)
    : [...current, suite.id]
}

const isSelected = (suite: TestSuite): boolean => (selected.value ?? []).includes(suite.id)

const profileName = computed(
  () =>
    detected.value.find((d) => d.stackId === chosenId.value)?.stackLabel ??
    stack.value?.label ??
    '',
)

const detectHint = computed(() =>
  detected.value.length > 0
    ? `Looks like ${detected.value.map((s) => s.stackLabel).join(' + ')} from the project files — confirm that or pick another.`
    : 'Nothing conclusive in the project files — pick the stack yourself.',
)

const isolated = computed(() => settingsStore.settings?.projectIsolatedRuns?.[props.projectId] ?? false)

function toggleIsolated(): void {
  void settingsStore.save({
    projectIsolatedRuns: {
      ...(settingsStore.settings?.projectIsolatedRuns ?? {}),
      [props.projectId]: !isolated.value,
    },
  })
}

function chooseStack(id: string): void {
  selected.value = null
  void settingsStore.save({
    projectTestStacks: { ...(settingsStore.settings?.projectTestStacks ?? {}), [props.projectId]: id },
  })
}

const acceptedGates = computed(
  () => new Set(settingsStore.settings?.projectAcceptedGates?.[props.projectId] ?? []),
)

function toggleAccepted(gateId: string): void {
  const next = new Set(acceptedGates.value)
  if (!next.delete(gateId)) next.add(gateId)
  void settingsStore.save({
    projectAcceptedGates: {
      ...(settingsStore.settings?.projectAcceptedGates ?? {}),
      [props.projectId]: [...next],
    },
  })
}

const { gates, score } = useVerifyGates(latest, acceptedGates)

const activeSession = useActiveSessionStore()
const FULL_SCREEN_KEY = 'tests'
const isFullScreen = computed(() => activeSession.fullScreenSection === FULL_SCREEN_KEY)

function toggleFullScreen(): void {
  activeSession.setFullScreen(isFullScreen.value ? null : FULL_SCREEN_KEY)
}

function onFullScreenKey(event: KeyboardEvent): void {
  if (event.key === 'Escape' && isFullScreen.value) {
    event.preventDefault()
    activeSession.setFullScreen(null)
  }
}

onMounted(() => window.addEventListener('keydown', onFullScreenKey))
onUnmounted(() => {
  window.removeEventListener('keydown', onFullScreenKey)
  if (isFullScreen.value) activeSession.setFullScreen(null)
})

const SUB_TABS: { id: SubTab; label: string; built: boolean }[] = [
  { id: 'api', label: 'API', built: true },
  { id: 'evidence', label: 'Results', built: true },
  { id: 'coverage', label: 'Coverage', built: true },
  { id: 'quality', label: 'Quality', built: true },
  { id: 'qa', label: 'Manual QA', built: true },
  { id: 'skill', label: 'Skill', built: false },
]

const subTabs = computed(() =>
  SUB_TABS.map((t) => ({
    ...t,
    badge: t.id === 'qa' ? evals.listFor(props.projectId).filter((r) => r.verdict === 'pending').length : 0,
  })),
)

async function runVerify(): Promise<void> {
  if (!stack.value || (selected.value ?? []).length === 0) return
  if (await verify.start(props.projectId, stack.value.id, selected.value ?? [], isolated.value)) {
    subTab.value = 'evidence'
  }
}

async function captureEvidence(): Promise<void> {
  if (await verify.captureEvidence(props.projectId, latest.value?.id)) {
    subTab.value = 'evidence'
  }
}

async function cancelVerify(): Promise<void> {
  if (latest.value) await verify.cancel(props.projectId, latest.value.id)
}

async function cancelApi(): Promise<void> {
  if (apiRun.value) await api.cancel(props.projectId, apiRun.value.id)
}

const {
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
} = useApiEvalSet(() => props.projectId)

function expectWords(e: ApiExpect): string {
  const parts = [e.status !== null ? `status ${e.status}` : 'any 2xx']
  if (e.minItems !== null) parts.push(`at least ${e.minItems} items`)
  if (e.mustContain) parts.push(`body contains "${e.mustContain}"`)
  return parts.join(' · ')
}

const report = computed(() => latest.value?.report ?? null)
const evidence = computed(() => report.value?.evidence ?? [])

const suiteResults = computed(
  () => new Map((report.value?.suites ?? []).map((s) => [s.id, s])),
)

const inFlight = computed<Set<string>>(() =>
  running.value ? new Set(latest.value?.requested ?? []) : new Set<string>(),
)

const suiteRows = computed<
  { suite: TestSuite; result: SuiteResult | null; retrying: boolean }[]
>(() =>
  suites.value.map((s) => ({
    suite: s,
    result: suiteResults.value.get(s.id) ?? null,
    retrying: inFlight.value.has(s.id),
  })),
)

const qualityGateLabel = computed(() => {
  const gate = report.value?.quality.gate
  if (gate === 'not_configured') return 'not connected'
  return gate ?? '—'
})

const qualityDebtSource = computed(() =>
  report.value?.quality.debt
    ? (report.value?.quality.gateSource ?? 'quality service')
    : 'nothing measured it',
)

const mutationCounts = computed(() => {
  const killed = report.value?.quality.mutationKilled
  const survived = report.value?.quality.mutationSurvived
  return killed == null || survived == null ? null : `${killed} killed · ${survived} survived`
})

const endpoints = computed(() => report.value?.endpoints ?? [])
const endpointsEmpty = computed(() => {
  const asked = (latest.value?.requested ?? []).filter((id) => suiteById(id)?.kind === 'api')
  if (asked.length === 0) return 'No API suite in this run. Include one above to call real endpoints.'
  if (running.value) return 'The run is still going. Endpoint calls appear here as it reports them.'
  if (!report.value) {
    return 'This run reported nothing, so no endpoint call can be shown. The note above says why.'
  }
  if (dbServers.value.length === 0) {
    return 'No database MCP server was connected on this session, so the run had no real rows to call the endpoints with. Connect one in the MCP section, then run again.'
  }
  return `The API suite ran but reported no individual endpoint calls, even though ${dbServers.value.join(' and ')} was available.`
})

const dbServers = computed(() => {
  const configured = settingsStore.settings?.databaseMcpServers ?? []
  const live = projectsStore.items.find((p) => p.id === props.projectId)?.session?.mcpServers ?? []
  const connected = live.filter((s) => s.status.toLowerCase() === 'connected').map((s) => s.name)
  return configured.filter((name) => connected.includes(name))
})

function statusClass(status: number | null): string {
  if (status === null) return ''
  if (status < 300) return 'pass'
  return status < 500 ? 'warn' : 'fail'
}

const results = computed(() =>
  (report.value?.suites ?? []).map((r) => ({ ...r, label: suiteById(r.id)?.label ?? r.label })),
)

const runSummary = computed(() => {
  const run = latest.value
  if (!run) return 'No verification run yet.'
  const when = new Date(run.startedAt).toLocaleString()
  const where = run.branch ? ` on ${run.branch}` : ''
  return run.status === 'running' ? `Running since ${when}${where}` : `${when}${where}`
})

const verifyEstimate = computed(() => {
  const chosen = [...(selected.value ?? [])].sort().join(',')
  return estimateRunMs(
    verify.listFor(props.projectId),
    (run) => [...((run as VerifyRun).requested ?? [])].sort().join(',') === chosen,
  )
})

const verifyEstimateLine = computed(() => {
  const estimate = verifyEstimate.value
  if (!estimate) return null
  const lead = running.value ? 'expected' : 'usually takes'
  return `${lead} ~${humanDuration(estimate.ms)} · ${estimate.basis}`
})

const apiEstimateLine = computed(() => {
  const estimate = estimateRunMs(api.runsFor(props.projectId))
  if (!estimate) return null
  return `${apiRunning.value ? 'expected' : 'usually takes'} ~${humanDuration(estimate.ms)} · ${estimate.basis}`
})

function statusWord(run: VerifyRun): string {
  return run.status === 'running' ? 'running' : run.status
}
</script>

<template>
  <div class="tests" data-testid="tests-view">
    <template v-if="!stack">
      <div class="intro">
        Pick the verification stack for <span class="proj">{{ projectName }}</span> — it decides which
        suites, gates and commands this section offers.
        <span class="hint" data-testid="tests-detect-hint">{{ detectHint }}</span>
      </div>
      <button
        v-for="s in TEST_STACKS"
        :key="s.id"
        class="stack-row"
        :data-testid="`tests-stack-${s.id}`"
        @click="chooseStack(s.id)"
      >
        <span class="stack-name">{{ s.label }}</span>
        <span class="stack-sub mono">{{ s.suites.map((x) => x.label).join(' · ') }}</span>
        <span v-if="detected.some((d) => d.stackId === s.id)" class="det mono">DETECTED</span>
      </button>
    </template>

    <template v-else>
      <div class="prof">
        <div class="prof-head">
          <span class="prof-name">{{ profileName }}</span>
          <span class="prof-sub mono" data-testid="tests-suite-count">
            {{ (selected ?? []).length }} of {{ suites.length }} suites
          </span>
          <span class="spacer"></span>
          <button
            class="link"
            data-testid="tests-full-screen"
            :aria-pressed="isFullScreen ? 'true' : 'false'"
            :title="
              isFullScreen
                ? 'Give the sidebar and inbox back (or press Escape)'
                : 'Hide the sidebar, inbox and header, and give this section the whole window'
            "
            @click="toggleFullScreen"
          >
            {{ isFullScreen ? 'exit full screen' : 'full screen' }}
          </button>
          <button class="link" data-testid="tests-change-stack" @click="chooseStack('')">change stack</button>
        </div>
        <div class="prof-meta mono">
          {{ branch ? `on ${branch}` : 'no branch' }} · verification runs through the session, never as
          its own process
        </div>

        <div
          v-if="latest"
          class="prof-meta mono"
          data-testid="tests-run-state"
          role="status"
        >
          {{ running ? 'Running…' : `Last run ${statusWord(latest)}` }} · {{ runSummary }}
        </div>

        <MiniTerminal v-if="running && latest?.sessionId" :session-id="latest.sessionId" label="verifying" />

        <div v-if="verifyEstimateLine" class="prof-meta mono" data-testid="tests-estimate">
          {{ verifyEstimateLine
          }}<span v-if="verifyEstimate && !verifyEstimate.comparable"> — treat it loosely</span>
        </div>

        <div class="suites" data-testid="tests-suites">
          <template v-for="row in suiteRows" :key="row.suite.id">
            <button
              class="chip suite"
              :class="[
                {
                  on: isSelected(row.suite),
                  dev: !!blockedReason(row.suite),
                  'q-surface': isQueuedRetry(row),
                },
                row.retrying ? 'ran-retry' : row.result ? `ran-${row.result.status}` : '',
              ]"
              :disabled="!!blockedReason(row.suite)"
              :title="chipTitle(row)"
              :data-testid="`tests-suite-${row.suite.id}`"
              @click="toggleSuite(row.suite)"
            >
              <span
                v-if="row.retrying"
                class="suite-mark"
                :data-testid="`tests-suite-mark-${row.suite.id}`"
                aria-hidden="true"
              >
                <Icon name="dot" :size="9" />
              </span>
              <span
                v-else-if="row.result"
                class="suite-mark"
                :data-testid="`tests-suite-mark-${row.suite.id}`"
                aria-hidden="true"
              >
                <Icon
                  v-if="row.result.status === 'pass'"
                  name="check"
                  :size="11"
                />
                <template v-else-if="row.result.status === 'fail'">✕</template>
                <template v-else>–</template>
              </span>
              {{ row.suite.label }}
              <span v-if="blockedReason(row.suite)" class="dev-tag">{{ blockedReason(row.suite) }}</span>
              <span v-else-if="row.suite.heavy" class="heavy-tag mono">slow</span>
              <span v-if="commandOverrides[row.suite.id]" class="heavy-tag mono">edited</span>
            </button>
            <button
              class="chip cmd-edit mono"
              :data-testid="`tests-suite-edit-${row.suite.id}`"
              :title="`Edit the command for ${row.suite.label}`"
              @click="editCommand(row.suite)"
            >
              <Icon name="pencil" :size="12" />
            </button>
          </template>
        </div>
        <div v-if="editingCommand" class="cmd-row">
          <input
            v-model="commandDraft"
            class="mono cmd-input"
            :data-testid="`tests-suite-command-${editingCommand}`"
            spellcheck="false"
            @keydown.enter="saveCommand(suites.find((s) => s.id === editingCommand)!)"
            @keydown.esc="editingCommand = null"
            @blur="saveCommand(suites.find((s) => s.id === editingCommand)!)"
          />
          <span class="lbl mono">empty restores the default</span>
        </div>

        <div class="targets">
          <span class="lbl">verify</span>
          <button class="chip on" data-testid="tests-target-tree">Working tree</button>
          <span class="spacer"></span>
          <button
            class="chip"
            :disabled="!latest || running"
            data-testid="tests-evidence"
            title="Execute the changed code and attach what it actually produced"
            @click="captureEvidence()"
          >
            Capture evidence
          </button>
          <button
            v-if="running && latest"
            class="chip"
            data-testid="tests-cancel"
            title="Stop the session's current turn and close this run. It stops whatever the session is doing, not only the tests."
            @click="cancelVerify()"
          >
            Cancel
          </button>
          <span class="iso-inline mono">
            <button
              class="switch"
              :class="{ on: isolated }"
              data-testid="tests-isolated"
              role="switch"
              :aria-checked="isolated"
              :disabled="verify.starting || running"
              title="Each suite runs in its own fresh container, one at a time, so a heavy suite cannot exhaust the memory the others need. Only one suite runs at a time, so an isolated run takes longer than a combined one."
              @click="toggleIsolated()"
            >
              <span class="knob"></span>
            </button>
            <span>Isolate each suite</span>
          </span>
          <button
            class="run"
            :disabled="verify.starting || running || (selected ?? []).length === 0"
            data-testid="tests-run"
            @click="runVerify()"
          >
            <template v-if="running"><Icon name="dot" :size="8" /> Running…</template>
            <template v-else><Icon name="play" :size="12" /> Run verification</template>
          </button>
        </div>
        <div v-if="verify.error" class="err" data-testid="tests-error">{{ verify.error }}</div>
      </div>

      <div class="score-row">
        <span class="score-label mono">QUALITY</span>
        <span
          class="score-val"
          :class="score ? (score.pct === 100 ? 'good' : score.pct >= 60 ? 'ok' : 'bad') : 'none'"
          data-testid="tests-score"
          :title="
            score
              ? `${score.passed} of ${score.measured} measured gates clean. ${score.total - score.measured} gate(s) measured nothing and are excluded.`
              : 'No gate has measured anything yet.'
          "
        >
          {{ score ? `${score.pct}%` : '—' }}
        </span>
        <span class="score-sub" data-testid="tests-score-sub">
          <template v-if="score">
            {{ score.passed }}/{{ score.measured }} gates clean<template
              v-if="score.measured < score.total"
              >, {{ score.total - score.measured }} unmeasured</template
            >
          </template>
          <template v-else>nothing measured yet</template>
        </span>
      </div>

      <div class="gates" data-testid="tests-gates">
        <div v-for="g in gates" :key="g.id" class="gate-cell">
          <button
            class="gate"
            :class="[g.status, { accepted: g.accepted }]"
            :data-testid="`tests-gate-${g.id}`"
            :title="`Target: ${g.target}`"
            @click="subTab = g.panel"
          >
            <span class="gate-name mono">{{ g.name }}</span>
            <span
              v-if="g.verified"
              class="gate-verified mono"
              :data-testid="`tests-gate-verified-${g.id}`"
              title="Read from the test runner's own report file, not from what the session said"
              >checked</span
            >
            <span class="gate-value">{{ g.value }}</span>
            <span class="gate-sub">{{ g.sub }}</span>
            <span class="gate-target mono">{{ g.target }}</span>
          </button>
          <button
            v-if="g.acceptable"
            class="gate-accept mono"
            :class="{ on: g.accepted }"
            :data-testid="`tests-gate-accept-${g.id}`"
            :aria-pressed="g.accepted ? 'true' : 'false'"
            :title="
              g.accepted
                ? `${g.name} is accepted. Click to withdraw that and leave it unmeasured.`
                : `Nothing measured ${g.name}. Accept it if you know why — the tile goes green and says you decided, and it stays out of the counted score.`
            "
            @click="toggleAccepted(g.id)"
          >
            {{ g.accepted ? 'accepted' : 'accept' }}
          </button>
        </div>
      </div>

      <div class="sub-tabs mono">
        <button
          v-for="t in subTabs"
          :key="t.id"
          class="st"
          :class="{ sel: subTab === t.id, dev: !t.built }"
          :data-testid="`tests-sub-${t.id}`"
          @click="subTab = t.id"
        >
          {{ t.label }}
          <span v-if="t.badge > 0" class="st-badge">{{ t.badge }}</span>
          <span v-if="!t.built" class="dev-dot" title="In development"><Icon name="circle" :size="11" /></span>
        </button>
      </div>

      <EvalsView
        v-if="subTab === 'qa'"
        :project-id="projectId"
        :project-name="projectName"
        @ran="emit('ran')"
        @run="(text) => emit('run', text)"
      />

      <div v-else-if="subTab === 'api'" class="panel" data-testid="tests-panel-api">
        <div class="panel-head">
          <span class="panel-title">API eval set</span>
          <span class="panel-meta mono">{{ apiSummary }}</span>
          <span v-if="apiRun" class="verdict mono" :class="apiRun.status">{{ apiRun.status }}</span>
        </div>
        <p class="quiet">
          The app sends these requests itself and decides pass or fail from the status and body that
          came back. The session is asked for one thing: identifiers that really exist.
        </p>

        <MiniTerminal
          v-if="apiRunning && apiRun?.sessionId"
          :session-id="apiRun.sessionId"
          label="gathering data"
        />

        <div class="host">
          <label class="host-field">
            <span class="host-lbl mono">base URL</span>
            <input
              v-model="baseUrlField"
              class="host-in mono"
              placeholder="http://localhost:5057"
              data-testid="tests-api-base"
            />
          </label>
          <label class="host-field">
            <span class="host-lbl mono">start command</span>
            <input
              v-model="startCmdField"
              class="host-in mono"
              placeholder="dotnet run --project ..."
              data-testid="tests-api-start"
            />
          </label>
        </div>
        <div class="host">
          <label class="host-field">
            <span class="host-lbl mono">QA URL</span>
            <input
              v-model="qaUrlField"
              class="host-in mono"
              placeholder="https://qa.example.com"
              data-testid="tests-api-qa"
            />
          </label>
          <label class="host-field">
            <span class="host-lbl mono">QA headers</span>
            <input
              v-model="qaHeadersField"
              class="host-in mono"
              placeholder="x-api-key: ${QA_API_KEY}"
              data-testid="tests-api-qa-headers"
            />
          </label>
          <button class="chip" data-testid="tests-api-save-host" @click="saveApiHost()">Save</button>
        </div>
        <div class="host-from mono" data-testid="tests-api-host-from">{{ apiHostLine }}</div>
        <div class="host-from mono" data-testid="tests-api-qa-from">{{ apiQaLine }}</div>

        <div class="sec mono">LAST TESTED</div>
        <p v-if="apiShortlist.length === 0" class="empty">
          No endpoint found in this project's source{{
            apiScan ? ` (${apiScan.filesRead} files scanned)` : ''
          }}. Search below, or add a .http file the scan can read.
        </p>
        <div class="suites">
          <button
            v-for="(e, i) in apiShortlist"
            :key="`${e.method} ${e.template}`"
            class="chip"
            :class="{ on: isPicked(e) }"
            :data-testid="`tests-api-recent-${i}`"
            @click="togglePick(e)"
          >
            <span class="ep-method mono">{{ e.method }}</span>
            <span class="mono">{{ e.template }}</span>
          </button>
        </div>

        <div class="sec mono">
          SEARCH · {{ apiFoundCount }} FOUND{{ apiScan?.truncated ? ' (SCAN LIMIT REACHED)' : '' }}
        </div>
        <input
          v-model="search"
          class="host-in mono search"
          placeholder="filter by path, method or file"
          data-testid="tests-api-search"
        />
        <button
          v-for="(e, i) in apiMatches"
          :key="`${e.method} ${e.template}`"
          type="button"
          class="row pick"
          :class="{ on: isPicked(e) }"
          :data-testid="`tests-api-endpoint-${i}`"
          role="checkbox"
          :aria-checked="isPicked(e)"
          :aria-label="`${e.method} ${e.template}`"
          @click="togglePick(e)"
        >
          <span class="row-status mono" :class="isPicked(e) ? 'pass' : ''">
            <Icon :name="isPicked(e) ? 'check' : 'plus'" :size="12" />
          </span>
          <span class="ep-method mono">{{ e.method }}</span>
          <span class="row-name mono">{{ e.template }}</span>
          <span class="row-detail mono">{{ e.source }}</span>
        </button>

        <div class="targets">
          <span class="lbl">{{ picked.length }} selected</span>
          <button
            class="chip"
            :class="{ on: apiTarget === 'local' }"
            data-testid="tests-api-target-local"
            title="The API on this machine — started for you if nothing answers"
            @click="apiTarget = 'local'"
          >
            Local
          </button>
          <button
            class="chip"
            :class="{ on: apiTarget === 'qa', dev: !qaReady }"
            :disabled="!qaReady"
            :title="
              qaReady
                ? 'The deployed QA environment — never started, never stopped, reads only'
                : 'Set a QA URL above to run against a deployed environment'
            "
            data-testid="tests-api-target-qa"
            @click="apiTarget = 'qa'"
          >
            QA
          </button>
          <span v-if="apiEstimateLine" class="lbl mono" data-testid="tests-api-estimate">
            {{ apiEstimateLine }}
          </span>
          <span class="spacer"></span>
          <button
            v-if="apiRunning && apiRun"
            class="chip"
            data-testid="tests-api-cancel"
            title="Stop the session's current turn and close this run. Calls the app has already started sending finish on their own."
            @click="cancelApi()"
          >
            Cancel
          </button>
          <button
            class="run"
            :disabled="api.starting || apiRunning || picked.length === 0"
            data-testid="tests-api-run"
            @click="runApi()"
          >
            <template v-if="apiRunning"><Icon name="dot" :size="8" /> Running…</template>
            <template v-else
              ><Icon name="play" :size="12" /> Run against {{ apiTarget === 'qa' ? 'QA' : 'local' }}</template
            >
          </button>
        </div>
        <div v-if="api.error" class="err" data-testid="tests-api-error">{{ api.error }}</div>

        <div class="targets">
          <span class="sec mono">EVAL SET</span>
          <span class="spacer"></span>
          <button
            class="chip"
            :disabled="!apiRun || apiRunning"
            data-testid="tests-api-report"
            title="Write the full test report for this run into .switchboard/reports"
            @click="writeApiReport()"
          >
            Write test report
          </button>
        </div>
        <p v-if="api.reportPath" class="note mono" data-testid="tests-api-report-path">
          Report written to {{ api.reportPath }}
        </p>
        <p v-if="apiRun?.note" class="note" data-testid="tests-api-note">{{ apiRun.note }}</p>
        <p v-if="!apiRun" class="empty">
          Nothing called yet. Pick endpoints above and run - every result below is a request this app
          sent and a status it received.
        </p>
        <p v-else-if="apiRunning" class="empty">
          Waiting for request data from the session, then the app makes the calls.
        </p>
        <div
          v-for="(c, i) in apiRun?.calls ?? []"
          :key="`${c.request.method} ${c.request.path} ${i}`"
          class="ep"
          :data-testid="`tests-api-call-${i}`"
        >
          <div class="ep-head">
            <span class="ep-verdict mono" :class="c.outcome">{{ c.outcome.replace('_', ' ') }}</span>
            <span class="ep-method mono">{{ c.request.method }}</span>
            <span class="ep-path mono">{{ c.request.path }}</span>
            <span class="ep-status mono" :class="statusClass(c.status)">{{ c.status ?? '—' }}</span>
            <span class="ep-ms mono">{{ c.ms === null ? '—' : `${c.ms} ms` }}</span>
          </div>
          <div class="ep-line mono">
            <span class="ep-label">checked</span>{{ expectWords(c.request.expect) }}
          </div>
          <div v-if="c.detail" class="ep-detail">{{ c.detail }}</div>
          <div v-if="c.request.note" class="ep-line mono">
            <span class="ep-label">proves</span>{{ c.request.note }}
          </div>
          <div v-if="c.request.dataSource || c.request.dataQuery" class="ep-line mono">
            <span class="ep-label">data</span>
            {{ [c.request.dataSource, c.request.dataQuery].filter(Boolean).join(' · ') }}
          </div>
          <div v-if="c.body" class="ep-body mono">{{ c.body }}</div>
        </div>
      </div>

      <div v-else-if="subTab === 'evidence'" class="panel" data-testid="tests-panel-evidence">
        <div class="panel-head">
          <span class="panel-title">Results</span>
          <span class="panel-meta mono">{{ runSummary }}</span>
          <span v-if="latest" class="verdict mono" :class="latest.status">{{ statusWord(latest) }}</span>
        </div>
        <p v-if="latest?.note" class="note" data-testid="tests-run-note">{{ latest.note }}</p>
        <p v-if="!latest" class="empty">
          Nothing has run yet. Pick the suites above and run a verification pass — the session
          executes them and reports what happened.
        </p>

        <div v-for="r in results" :key="r.id" class="row" :data-testid="`tests-result-${r.id}`">
          <span class="row-status mono" :class="r.status">{{ r.status.replace('_', ' ') }}</span>
          <span class="row-name">{{ r.label }}</span>
          <span class="row-detail mono">{{ r.detail }}</span>
        </div>

        <div v-if="latest" class="sec mono">REAL ENDPOINTS, REAL DATA</div>
        <p v-if="latest && endpoints.length === 0" class="empty" data-testid="tests-endpoints-empty">
          {{ endpointsEmpty }}
        </p>
        <div
          v-for="(e, i) in endpoints"
          :key="`${e.method} ${e.path} ${i}`"
          class="ep"
          :data-testid="`tests-endpoint-${i}`"
        >
          <div class="ep-head">
            <span class="ep-verdict mono" :class="e.outcome">{{ e.outcome.replace('_', ' ') }}</span>
            <span class="ep-method mono">{{ e.method }}</span>
            <span class="ep-path mono">{{ e.path }}</span>
            <span class="ep-status mono" :class="statusClass(e.status)">{{ e.status ?? '—' }}</span>
            <span class="ep-ms mono">{{ e.ms === null ? '—' : `${e.ms} ms` }}</span>
          </div>
          <div v-if="e.detail" class="ep-detail">{{ e.detail }}</div>
          <div v-if="e.dataSource || e.dataQuery" class="ep-line mono">
            <span class="ep-label">data</span>{{ [e.dataSource, e.dataQuery].filter(Boolean).join(' · ') }}
          </div>
          <div v-if="e.dataAssertion" class="ep-line mono">
            <span class="ep-label">checked</span>{{ e.dataAssertion }}
          </div>
          <div v-if="e.response" class="ep-body mono">{{ e.response }}</div>
        </div>

        <div class="sec mono">ACTUAL RUNS AGAINST THE BUILD</div>
        <p v-if="evidence.length === 0" class="empty">
          No evidence captured. "Capture evidence" executes the changed code and records the real
          inputs and the real results — nothing here is ever written from reading the code.
        </p>
        <div
          v-for="(e, i) in evidence"
          :key="`${e.kind}:${e.what}`"
          class="ev"
          :data-testid="`tests-evidence-${i}`"
        >
          <span class="ev-kind mono">{{ e.kind }}</span>
          <div class="ev-body">
            <div class="ev-what">{{ e.what }}</div>
            <div class="ev-result mono">{{ e.result }}</div>
            <div v-if="e.path" class="ev-path mono">{{ e.path }}</div>
          </div>
        </div>
      </div>

      <div v-else-if="subTab === 'coverage'" class="panel" data-testid="tests-panel-coverage">
        <div class="panel-head">
          <span class="panel-title">Coverage</span>
          <span class="panel-meta mono">{{ runSummary }}</span>
        </div>
        <div class="figs">
          <div class="fig" data-testid="tests-coverage-line">
            <span class="fig-name mono">LINE</span>
            <span class="fig-value">{{ pct(report?.coverage.line ?? unmeasured) }}</span>
            <span class="fig-src mono">{{ sourceOf(report?.coverage.line ?? unmeasured) }}</span>
          </div>
          <div class="fig" data-testid="tests-coverage-changed">
            <span class="fig-name mono">CHANGED LINES</span>
            <span class="fig-value">{{ pct(report?.coverage.changed ?? unmeasured) }}</span>
            <span class="fig-src mono">{{ sourceOf(report?.coverage.changed ?? unmeasured) }}</span>
          </div>
        </div>
        <div class="sec mono">FILES YOU TOUCHED</div>
        <p v-if="!report?.coverage.files.length" class="empty">
          No per-file coverage in this run. Include a coverage suite above, and the report the run
          produces fills this in.
        </p>
        <div v-for="f in report?.coverage.files ?? []" :key="f.path" class="row">
          <span class="row-status mono" :class="f.pct >= 80 ? 'pass' : 'warn'">{{ round(f.pct) }}%</span>
          <span class="row-name mono">{{ f.path }}</span>
        </div>
      </div>

      <div v-else-if="subTab === 'quality'" class="panel" data-testid="tests-panel-quality">
        <div class="panel-head">
          <span class="panel-title">Quality</span>
          <span class="panel-meta mono">{{ runSummary }}</span>
        </div>
        <div class="figs">
          <div class="fig" data-testid="tests-quality-gate">
            <span class="fig-name mono">QUALITY GATE</span>
            <span class="fig-value">{{ qualityGateLabel }}</span>
            <span class="fig-src mono">{{ report?.quality.gateSource ?? 'no quality service reported' }}</span>
          </div>
          <div class="fig" data-testid="tests-quality-duplication">
            <span class="fig-name mono">DUPLICATION</span>
            <span class="fig-value">{{ pct(report?.quality.duplication ?? unmeasured) }}</span>
            <span class="fig-src mono">{{ sourceOf(report?.quality.duplication ?? unmeasured) }}</span>
          </div>
          <div class="fig" data-testid="tests-quality-debt">
            <span class="fig-name mono">DEBT</span>
            <span class="fig-value">{{ report?.quality.debt ?? '—' }}</span>
            <span class="fig-src mono">{{ qualityDebtSource }}</span>
          </div>
          <div class="fig" data-testid="tests-quality-mutation">
            <span class="fig-name mono">MUTATION</span>
            <span class="fig-value">{{ pct(report?.quality.mutation ?? unmeasured) }}</span>
            <span class="fig-src mono">{{ sourceOf(report?.quality.mutation ?? unmeasured) }}</span>
          </div>
        </div>

        <div class="sec mono">ARCHITECTURE</div>
        <p v-if="!report?.quality.findings.length" class="empty">
          {{
            report?.quality.archViolations.value === 0
              ? 'No rule violations reported by the architecture suite.'
              : 'No architecture findings in this run — include an architecture suite to get them.'
          }}
        </p>
        <div v-for="f in report?.quality.findings ?? []" :key="f" class="row">
          <span class="row-status mono fail">rule</span>
          <span class="row-name">{{ f }}</span>
        </div>

        <div class="sec mono">
          SURVIVING MUTANTS<template v-if="mutationCounts"> · {{ mutationCounts }}</template>
        </div>
        <p v-if="!report?.quality.survivors.length" class="empty">
          No surviving mutants reported. Mutation testing is a slow suite — tick it above to include
          it in a run.
        </p>
        <div v-for="s in report?.quality.survivors ?? []" :key="s" class="row">
          <span class="row-status mono warn">survived</span>
          <span class="row-name mono">{{ s }}</span>
        </div>
      </div>

      <div v-else class="dev-panel" data-testid="tests-dev-skill">
        <div class="dev-badge">in development</div>
        <div class="dev-title">Verify skill</div>
        <div class="dev-sections mono">
          <span class="dev-section">TEST SKILL</span>
          <span class="dev-section">WHAT A FULL RUN EXECUTES</span>
          <span class="dev-section">GET IT IN FRONT OF YOU</span>
        </div>
        <div class="dev-body">
          A generated test skill for this stack: what a full run executes, the harness that gets it
          in front of you, and the gates it knows. The stack catalogue above does that job today;
          generating a per-project skill does not exist yet.
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.score-row {
  display: flex;
  align-items: baseline;
  gap: 9px;
  padding: 0 0 8px;
}

.score-label {
  font-size: var(--fs-micro);
  text-transform: uppercase;
  letter-spacing: var(--track-label);
  color: var(--text-ghost);
}

.score-val {
  font-size: var(--fs-title);
  font-weight: var(--w-em);
  font-variant-numeric: tabular-nums;
}

.score-val.good {
  color: var(--green);
}

.score-val.ok {
  color: var(--amber);
}

.score-val.bad {
  color: var(--red);
}

.score-val.none {
  color: var(--text-ghost);
}

.score-sub {
  font-size: var(--fs-meta);
  color: var(--text-faint);
}

.tests {
  flex: 1;
  overflow-y: auto;
  padding: 18px 22px 52px;
}

.intro {
  max-width: 840px;
  font-size: var(--fs-ui);
  line-height: 1.6;
  color: var(--text-mid);
  margin-bottom: 14px;
  text-wrap: pretty;
}

.intro .proj {
  color: var(--text-body);
}

.intro .hint {
  display: block;
  margin-top: 6px;
  font-size: var(--fs-meta);
  color: var(--text-faint);
}

.stack-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  width: 100%;
  padding: 10px 13px;
  margin-bottom: 6px;
  text-align: left;
  background: var(--bg-card);
  box-shadow: var(--elev);
  border: 1px solid var(--border-card);
  border-radius: var(--rc);
  cursor: pointer;
}

.stack-row:hover {
  border-color: var(--green);
}

.stack-name {
  flex-shrink: 0;
  width: 210px;
  font-size: var(--fs-ui);
  color: var(--text-bright);
}

.stack-sub {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-micro);
  color: var(--text-faint);
  line-height: 1.55;
  text-wrap: pretty;
}

.det {
  flex-shrink: 0;
  font-size: var(--fs-micro);
  color: var(--green);
  border: 1px solid color-mix(in srgb, var(--green) 32%, transparent);
  background: color-mix(in srgb, var(--green) 10%, transparent);
  border-radius: var(--rp);
  padding: 1px 9px;
}

.prof {
  margin-bottom: 14px;
}

.prof-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.prof-name {
  font-size: var(--fs-body);
  font-weight: var(--w-em);
  color: var(--text-bright);
}

.prof-sub,
.prof-meta {
  font-size: var(--fs-micro);
  color: var(--text-faint);
}

.prof-meta {
  margin-top: 3px;
}

.link {
  font-size: var(--fs-micro);
  color: var(--text-faint);
  text-decoration: underline;
  cursor: pointer;
}

.link:hover {
  color: var(--green);
}

.suites {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 11px;
}

.targets {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 9px;
}

.lbl {
  font-size: var(--fs-micro);
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  font-size: var(--fs-meta);
  color: var(--text-body);
  border: 1px solid var(--border-strong);
  border-radius: var(--rc);
  cursor: pointer;
}

.chip:hover:not(:disabled) {
  border-color: var(--green);
}

.chip:disabled {
  cursor: not-allowed;
}

.chip.on {
  color: var(--green);
  border-color: color-mix(in srgb, var(--green) 50%, transparent);
  background: color-mix(in srgb, var(--green) 10%, transparent);
}

.suite-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 12px;
  font-size: var(--fs-micro);
  line-height: 1;
}

.chip.suite.ran-pass {
  color: var(--green);
  border-color: var(--green);
  background: color-mix(in srgb, var(--green) 16%, transparent);
}

.chip.suite.ran-fail {
  color: var(--red);
  border-color: var(--red);
  background: color-mix(in srgb, var(--red) 16%, transparent);
}

.chip.suite.q-surface {
  color: var(--amber);
  border-color: var(--amber);
  background: color-mix(in srgb, var(--amber) 16%, transparent);
}

.chip.suite.ran-retry {
  color: var(--amber);
  border-color: var(--amber);
  background: color-mix(in srgb, var(--amber) 16%, transparent);
}

.chip.suite.ran-skipped,
.chip.suite.ran-not_run,
.chip.suite.ran-unavailable {
  color: var(--text-meta);
  border-color: var(--border-strong);
  background: transparent;
}

.chip.suite.on {
  box-shadow:
    0 0 0 2px var(--bg-panel),
    0 0 0 4px color-mix(in srgb, var(--text-body) 55%, transparent);
  font-weight: var(--w-em);
}

.heavy-tag {
  font-size: var(--fs-micro);
  color: var(--text-ghost);
}

.cmd-edit {
  padding: 4px 7px;
  margin-left: -4px;
  color: var(--text-ghost);
}

.cmd-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 7px;
}

.cmd-input {
  flex: 1;
  font-size: var(--fs-meta);
  padding: 5px 8px;
  background: var(--bg-code);
  border: 1px solid var(--border-strong);
  border-radius: var(--rc);
  color: var(--text-body);
}

.iso-inline {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: var(--fs-meta);
  color: var(--text-faint);
}

.run {
  flex-shrink: 0;
  padding: 6px 14px;
  font-size: var(--fs-meta);
  font-weight: var(--w-em);
  color: var(--green-ink);
  background: var(--green);
  border-radius: var(--rc);
  cursor: pointer;
}

.run:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.err {
  margin-top: 8px;
  font-size: var(--fs-meta);
  color: var(--red);
}

.gates {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(168px, 1fr));
  gap: 7px;
  margin-bottom: 16px;
}

.gate-cell {
  position: relative;
  display: flex;
}

.gate {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 9px 11px;
  text-align: left;
  background: var(--bg-card);
  box-shadow: var(--elev);
  border: 1px solid var(--border-card);
  border-radius: var(--rc);
  cursor: pointer;
}

.gate:hover {
  border-color: var(--green);
}

.gate-name {
  font-size: var(--fs-micro);
  letter-spacing: 0.05em;
  color: var(--text-faint);
}

.gate-verified {
  font-size: var(--fs-micro);
  letter-spacing: 0.05em;
  color: var(--green);
  opacity: 0.75;
}

.gate-value {
  font-size: var(--fs-title);
  font-weight: 400;
  color: var(--text-bright);
}

.gate-sub {
  font-size: var(--fs-micro);
  color: var(--text-mid);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gate-target {
  margin-top: 3px;
  font-size: var(--fs-micro);
  color: var(--text-on-wash);
}

.gate.pass .gate-value {
  color: var(--green);
}


.gate-accept {
  position: absolute;
  top: 6px;
  right: 6px;
  padding: 1px 5px;
  font-size: var(--fs-micro);
  letter-spacing: 0.05em;
  color: var(--text-faint);
  background: var(--bg-hover);
  border: 1px solid var(--border-card);
  border-radius: var(--r-row);
  opacity: 0.55;
  transition: opacity 120ms var(--ease-overlay);
}

.gate-cell:hover .gate-accept,
.gate-accept:focus-visible,
.gate-accept.on {
  opacity: 1;
}

.gate-accept:hover {
  color: var(--text-bright);
  border-color: var(--blue);
}

.gate-accept.on {
  color: var(--blue);
  border-color: var(--blue);
}

@media (prefers-reduced-motion: reduce) {
  .gate-accept {
    transition: none;
  }
}

.gate.fail .gate-value {
  color: var(--red);
}

.gate.warn .gate-value {
  color: var(--amber);
}

.gate.none {
  opacity: 0.62;
}

.dev-tag {
  font-size: var(--fs-micro);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--amber);
}

.sub-tabs {
  display: flex;
  gap: 2px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 14px;
}

.st {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  font-size: var(--fs-meta);
  letter-spacing: var(--track-label);
  text-transform: uppercase;
  color: var(--text-tab);
  border-bottom: 2px solid transparent;
  cursor: pointer;
}

.st:hover {
  color: var(--text-body);
}

.st.sel {
  color: var(--text-bright);
  border-bottom-color: var(--green);
}

.st.dev {
  color: var(--text-ghost);
}

.st-badge {
  font-size: var(--fs-micro);
  color: var(--green-ink);
  background: var(--green);
  border-radius: var(--rp);
  padding: 0 5px;
}

.dev-dot {
  font-size: var(--fs-micro);
  color: var(--amber);
}

.panel {
}

.panel-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 10px;
}

.panel-title {
  font-size: var(--fs-body);
  color: var(--text-bright);
}

.panel-meta {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-micro);
  color: var(--text-faint);
}

.verdict {
  font-size: var(--fs-micro);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  border-radius: var(--rp);
  padding: 1px 9px;
  border: 1px solid var(--border-strong);
  color: var(--text-mid);
}

.verdict.pass {
  color: var(--green);
  border-color: color-mix(in srgb, var(--green) 40%, transparent);
}

.verdict.fail {
  color: var(--red);
}

.verdict.inconclusive,
.verdict.running {
  color: var(--amber);
}

.note {
  font-size: var(--fs-meta);
  color: var(--amber);
  margin-bottom: 10px;
}

.quiet {
  font-size: var(--fs-meta);
  color: var(--text-mid);
  margin-bottom: 10px;
}

.host {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}

.host-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex: 1 1 220px;
}

.host-lbl {
  font-size: var(--fs-micro);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-ghost);
}

.host-in {
  padding: 5px 8px;
  font-size: var(--fs-meta);
  color: var(--text-body);
  background: transparent;
  border: 1px solid var(--border-strong);
  border-radius: var(--rc);
}

.host-in:focus {
  outline: none;
  border-color: var(--green);
}

.search {
  width: 100%;
  margin-bottom: 6px;
}

.host-from {
  margin-top: 5px;
  font-size: var(--fs-micro);
  color: var(--text-ghost);
}

.row.pick {
  cursor: pointer;
}

.row.pick:hover {
  background: color-mix(in srgb, var(--green) 6%, transparent);
}

.row.pick.on {
  background: color-mix(in srgb, var(--green) 10%, transparent);
}

.empty {
  max-width: 620px;
  font-size: var(--fs-ui);
  line-height: 1.6;
  color: var(--text-faint);
  margin-bottom: 10px;
  text-wrap: pretty;
}

.row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  width: 100%;
  text-align: left;
  padding: var(--pad-card);
  margin-bottom: 4px;
  background: var(--bg-hover);
  border: 1px solid var(--border-card);
  border-radius: var(--rc);
}

.row-status {
  flex-shrink: 0;
  width: 78px;
  font-size: var(--fs-micro);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-faint);
}

.row-status.pass {
  color: var(--green);
}

.row-status.fail {
  color: var(--red);
}

.row-status.warn,
.row-status.skipped,
.row-status.unavailable {
  color: var(--amber);
}

.row-name {
  flex-shrink: 0;
  width: 190px;
  font-size: var(--fs-ui);
  color: var(--text-body);
}

.row-detail {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-micro);
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sec {
  font-size: var(--fs-micro);
  letter-spacing: 0.05em;
  color: var(--text-ghost);
  margin: 16px 0 8px;
}

.figs {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
  gap: 7px;
}

.fig {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 9px 11px;
  background: var(--bg-card);
  border: 1px solid var(--border-card);
  border-radius: var(--rc);
}

.fig-name {
  font-size: var(--fs-micro);
  letter-spacing: 0.05em;
  color: var(--text-faint);
}

.fig-value {
  font-size: var(--fs-head);
  color: var(--text-bright);
}

.fig-src {
  font-size: var(--fs-micro);
  color: var(--text-on-wash);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ev {
  display: flex;
  gap: 10px;
  padding: 8px 10px;
  margin-bottom: 5px;
  background: var(--bg-card);
  border: 1px solid var(--border-card);
  border-radius: var(--rc);
}

.ev-kind {
  flex-shrink: 0;
  width: 74px;
  font-size: var(--fs-micro);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-faint);
}

.ev-body {
  flex: 1;
  min-width: 0;
}

.ev-what {
  font-size: var(--fs-ui);
  color: var(--text-body);
}

.ev-result {
  font-size: var(--fs-micro);
  color: var(--text-mid);
  margin-top: 2px;
  white-space: pre-wrap;
  word-break: break-word;
}

.ev-path {
  font-size: var(--fs-micro);
  color: var(--text-on-wash);
  margin-top: 3px;
}

.ep {
  padding: 8px 10px;
  margin-bottom: 5px;
  background: var(--bg-card);
  border: 1px solid var(--border-card);
  border-radius: var(--rc);
}

.ep-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ep-verdict {
  flex-shrink: 0;
  width: 52px;
  font-size: var(--fs-micro);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-faint);
}

.ep-verdict.pass {
  color: var(--green);
}

.ep-verdict.fail {
  color: var(--red);
}

.ep-method {
  flex-shrink: 0;
  font-size: var(--fs-micro);
  letter-spacing: 0.03em;
  color: var(--text-mid);
}

.ep-path {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-meta);
  color: var(--text-body);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ep-status {
  flex-shrink: 0;
  font-size: var(--fs-micro);
  color: var(--text-faint);
}

.ep-status.pass {
  color: var(--green);
}

.ep-status.warn {
  color: var(--amber);
}

.ep-status.fail {
  color: var(--red);
}

.ep-ms {
  flex-shrink: 0;
  width: 56px;
  font-size: var(--fs-micro);
  text-align: right;
  color: var(--text-on-wash);
}

.ep-detail {
  font-size: var(--fs-meta);
  color: var(--text-mid);
  margin-top: 4px;
  word-break: break-word;
}

.ep-line {
  font-size: var(--fs-micro);
  color: var(--text-on-wash);
  margin-top: 3px;
  word-break: break-word;
}

.ep-label {
  display: inline-block;
  width: 52px;
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.ep-body {
  font-size: var(--fs-micro);
  color: var(--text-mid);
  margin-top: 5px;
  padding-top: 5px;
  border-top: 1px solid var(--border-card);
  max-height: 168px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

.dev-panel {
  position: relative;
  max-width: 840px;
  padding: 15px 17px;
  background: var(--bg-hover);
  border: 1px dashed var(--border-strong);
  border-radius: var(--rc);
  opacity: 0.72;
}

.dev-badge {
  position: absolute;
  top: 13px;
  right: 15px;
  font-family: var(--mono);
  font-size: var(--fs-micro);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--amber);
  border: 1px solid color-mix(in srgb, var(--amber) 40%, transparent);
  background: color-mix(in srgb, var(--amber) 8%, transparent);
  border-radius: var(--rp);
  padding: 1px 9px;
}

.dev-title {
  font-size: var(--fs-body);
  color: var(--text-bright);
  margin-bottom: 6px;
}

.dev-sections {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 9px;
}

.dev-section {
  font-size: var(--fs-micro);
  letter-spacing: 0.05em;
  color: var(--text-ghost);
  border: 1px dashed var(--border-strong);
  border-radius: var(--rp);
  padding: 1px 8px;
}

.dev-body {
  max-width: 620px;
  font-size: var(--fs-ui);
  line-height: 1.6;
  color: var(--text-mid);
  text-wrap: pretty;
}
</style>
