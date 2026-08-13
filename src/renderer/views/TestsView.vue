<script setup lang="ts">
// Tests section shell — the design's verify surface: pick the project's stack,
// choose what to verify, run it, then read the six gates and drill into a panel.
//
// A run executes through the session and reports one machine-readable line; this
// view renders exactly what that line measured. A figure the run did not measure
// reads "—" with the reason, never a number nothing produced (spec 002 FR-072),
// and a suite this environment cannot run is named before the run starts rather
// than reported as a failure of the code (FR-057).
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
import { estimateRunMs, humanDuration, type VerifyRun } from '@shared/domain'
import { type ApiExpect } from '@shared/api-endpoints'
import { useEvalsStore } from '@renderer/stores/evals'
import { useVerifyStore } from '@renderer/stores/verify'
import { useApiStore } from '@renderer/stores/api'
import { useProjectsStore } from '@renderer/stores/projects'
import MiniTerminal from '@renderer/components/MiniTerminal.vue'
import { useSettingsStore } from '@renderer/stores/settings'
import { useApiEvalSet } from '@renderer/composables/useApiEvalSet'
import { pct, round, sourceOf, unmeasured, useVerifyGates } from '@renderer/composables/useVerifyGates'
import EvalsView from '@renderer/views/EvalsView.vue'

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
// Manual QA is the landing panel: with nothing run yet it is the one with
// content. Starting a run switches to Results, where its output lands.
const subTab = ref<SubTab>('qa')
// No `target` ref: only the working tree is scoped today and the other two chips
// are permanently disabled with no handler, so the ref could only ever hold
// 'tree'. The chip below is rendered always-selected until they are implemented.
/** Suite ids this run will cover; null until the stack is known. */
const selected = ref<string[] | null>(null)

// The shell owns the load: the picker needs detection before Manual QA (and so
// EvalsView) has mounted, and the panels need the runs.
let stopPush: (() => void) | null = null
let stopApiPush: (() => void) | null = null
onMounted(() => {
  void evals.load(props.projectId)
  void verify.load(props.projectId)
  void api.load(props.projectId)
  // The report arrives from the session, not from a click.
  stopPush = window.switchboard.on('push.verifyChanged', (push) => {
    verify.applyPush(push.projectId, push.runs)
  })
  // An API eval set finishes in the main process (the app makes the calls), so
  // its result arrives on its own channel rather than as a reply to the click.
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

/** A bypass session runs in the sandbox container: node, plus the .NET SDK when
 *  this project detects as .NET (docker-sandbox picks the image from the very
 *  same detection). Never Python, never a browser — which suites that rules out
 *  is shown before the run, not reported as a failure afterwards. */
const sandboxed = computed<SandboxEnv>(() =>
  projectsStore.items.find((p) => p.id === props.projectId)?.session?.bypassPermissions === true
    ? sandboxTools(sandboxNeedsDotnet(detected.value))
    : null,
)

// Prefer what detection actually found for this project over the raw catalog
// entry: a .NET project's suites are narrowed to whether it holds an API, a Blazor
// front end, or both, so a front end is not offered an HTTP smoke pass over
// endpoints it does not have. A stack the developer picked that detection did NOT
// find is an override, and gets the whole catalog entry — that choice is theirs.
const suites = computed<TestSuite[]>(() => {
  const found = detected.value.find((d) => d.stackId === chosenId.value)
  const catalogue = [...(found?.suites ?? stack.value?.suites ?? [])]
  // The catalogue's command is a guess about a conventional layout. Where the
  // developer has corrected it, that correction is what the chip shows and what
  // the run dispatches — verify.start applies the same overlay, so the two can
  // never say different things.
  const overrides = commandOverrides.value
  return catalogue.map((suite) =>
    overrides[suite.id] ? { ...suite, command: overrides[suite.id] } : suite,
  )
})
const blockedReason = (suite: TestSuite): string | null => unavailableReason(suite, sandboxed.value)

const commandOverrides = computed<Record<string, string>>(
  () => settingsStore.settings?.projectSuiteCommands?.[props.projectId] ?? {},
)

/** Which suite's command is open for editing; null when none is. */
const editingCommand = ref<string | null>(null)
const commandDraft = ref('')

function editCommand(suite: TestSuite): void {
  editingCommand.value = suite.id
  commandDraft.value = suite.command
}

/**
 * Save (or clear) one suite's command for this project.
 *
 * Both levels are spread deliberately: settings.set shallow-merges its patch, so
 * writing the project key without spreading the map would drop every other
 * project's overrides, and writing the suite key without spreading would drop
 * every other suite's. Typing the catalogue's own command back in, or emptying
 * the field, deletes the entry rather than storing a duplicate of the default.
 */
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

// The default selection follows the environment: heavy suites are opt-in, and a
// suite this environment cannot run starts unticked instead of failing later.
watch(
  [suites, sandboxed],
  ([list, sandbox]) => {
    if (list.length === 0) {
      selected.value = null
      return
    }
    if (selected.value === null) {
      selected.value = defaultSelection(list, sandbox)
      return
    }
    // The offered list narrows once detection lands — a .NET project turns out to
    // be an API and its Blazor suites go away. A selection may not outlive the
    // suite it names: a run must never be dispatched with an id this project was
    // never offered, and the count must never read "9 of 7".
    const offered = new Set(list.map((suite) => suite.id))
    const kept = selected.value.filter((id) => offered.has(id))
    if (kept.length !== selected.value.length) selected.value = kept
  },
  { immediate: true },
)

function toggleSuite(suite: TestSuite): void {
  if (blockedReason(suite)) return
  const current = selected.value ?? []
  selected.value = current.includes(suite.id)
    ? current.filter((id) => id !== suite.id)
    : [...current, suite.id]
}

const isSelected = (suite: TestSuite): boolean => (selected.value ?? []).includes(suite.id)

/** Names what is actually being verified — ".NET Blazor" rather than ".NET" —
 *  falling back to the catalog entry when the choice was an override. */
const profileName = computed(
  () =>
    detected.value.find((d) => d.stackId === chosenId.value)?.stackLabel ??
    stack.value?.label ??
    '',
)

/** Detection is a hint, never a decision — the developer confirms it (FR-034). */
const detectHint = computed(() =>
  detected.value.length > 0
    ? `Looks like ${detected.value.map((s) => s.stackLabel).join(' + ')} from the project files — confirm that or pick another.`
    : 'Nothing conclusive in the project files — pick the stack yourself.',
)

function chooseStack(id: string): void {
  selected.value = null
  void settingsStore.save({
    projectTestStacks: { ...(settingsStore.settings?.projectTestStacks ?? {}), [props.projectId]: id },
  })
}

// The six tiles, and the two rules that decide what each one may claim: an
// unmeasured figure reads "—" with its reason, and a skipped suite is a warning
// rather than a pass (see the composable).
const { gates, score } = useVerifyGates(latest)

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
    // Manual QA carries the count of lines still waiting on a verdict.
    badge: t.id === 'qa' ? evals.listFor(props.projectId).filter((r) => r.verdict === 'pending').length : 0,
  })),
)

// Starting a run does NOT jump to the session: the results land here, and
// browsing them has to stay usable while the run holds the session (FR-080).
// The session tab is one click away for the raw output.
async function runVerify(): Promise<void> {
  if (!stack.value || (selected.value ?? []).length === 0) return
  if (await verify.start(props.projectId, stack.value.id, selected.value ?? [])) {
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

// The API eval set: picked endpoints, where the calls go, and running them.
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

/** The check the app performed, in the terms it performed it. */
function expectWords(e: ApiExpect): string {
  const parts = [e.status !== null ? `status ${e.status}` : 'any 2xx']
  if (e.minItems !== null) parts.push(`at least ${e.minItems} items`)
  if (e.mustContain) parts.push(`body contains "${e.mustContain}"`)
  return parts.join(' · ')
}

const report = computed(() => latest.value?.report ?? null)
const evidence = computed(() => report.value?.evidence ?? [])

// The two quality tiles whose text is a decision rather than a value: an absent
// figure and a figure of "not configured" mean different things and must not
// read the same, and debt only has a source when there is a debt figure at all.
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

// "X killed / Y survived" beside the survivor list — the split the percentage
// alone does not say. Either count absent means the run never reported them
// (an older report, or a stack whose mutation tool the app cannot read), so
// the line is left off rather than showing a half figure.
const mutationCounts = computed(() => {
  const killed = report.value?.quality.mutationKilled
  const survived = report.value?.quality.mutationSurvived
  return killed == null || survived == null ? null : `${killed} killed · ${survived} survived`
})

// Real HTTP calls the run made, with the rows they were drawn from. Only API
// suites produce these, so an empty list means one of four different things and
// the message has to say which — otherwise "none" reads as "all passed".
const endpoints = computed(() => report.value?.endpoints ?? [])
const endpointsEmpty = computed(() => {
  // What the run was ASKED to cover, not what it has reported: `requested` is
  // there from the first moment, whereas the report only arrives at the end. A
  // mid-run panel reading the report would claim there was no API suite while
  // the API suite was still running.
  const asked = (latest.value?.requested ?? []).filter((id) => suiteById(id)?.kind === 'api')
  if (asked.length === 0) return 'No API suite in this run. Include one above to call real endpoints.'
  if (running.value) return 'The run is still going. Endpoint calls appear here as it reports them.'
  // An inconclusive run has no report at all: the session ended its turn without
  // reporting a result line. Saying anything about what "the API suite" did would
  // claim knowledge of a run that reported nothing.
  if (!report.value) {
    return 'This run reported nothing, so no endpoint call can be shown. The note above says why.'
  }
  if (dbServers.value.length === 0) {
    return 'No database MCP server was connected on this session, so the run had no real rows to call the endpoints with. Connect one in the MCP section, then run again.'
  }
  return `The API suite ran but reported no individual endpoint calls, even though ${dbServers.value.join(' and ')} was available.`
})

/** The same list the run itself was given: named in settings AND connected on this
 *  project's session. Mirrors the filter in the verify.start handler, so the empty
 *  state cannot claim a server was available when the prompt never offered it. */
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

/** A suite result decorated with the catalog's own label. */
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

// How long this will take, learned from this project's own past runs — shown
// before the run as well as during it, since "this is a four minute job" is
// most useful while deciding whether to start it. A run's length is dominated
// by which suites are in it, so past runs covering the same selection are
// preferred (the basis line says which kind it used); a run still in progress
// carries no finishedAt, so estimateRunMs ignores it without filtering.
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

/** The same learning for API eval sets, where the suite question does not arise. */
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
      <!-- Chosen profile: what is being verified, and the run control. -->
      <div class="prof">
        <div class="prof-head">
          <span class="prof-name">{{ profileName }}</span>
          <span class="prof-sub mono" data-testid="tests-suite-count">
            {{ (selected ?? []).length }} of {{ suites.length }} suites
          </span>
          <span class="spacer"></span>
          <button class="link" data-testid="tests-change-stack" @click="chooseStack('')">change stack</button>
        </div>
        <div class="prof-meta mono">
          {{ branch ? `on ${branch}` : 'no branch' }} · verification runs through the session, never as
          its own process
        </div>

        <!-- Run state, in the header rather than only inside the Results panel.
             Starting a run deliberately does not jump anywhere, so the developer is
             expected to keep working in another panel while it executes — which
             meant the run finishing was announced nowhere at all, and a screen
             reader user had no way to learn it had. role=status is an implicit
             aria-live="polite", and the line is visible because a sighted user
             gains the same thing: the verdict without navigating to find it. -->
        <div
          v-if="latest"
          class="prof-meta mono"
          data-testid="tests-run-state"
          role="status"
        >
          {{ running ? 'Running…' : `Last run ${statusWord(latest)}` }} · {{ runSummary }}
        </div>

        <!-- "Running…" for several minutes says nothing about whether anything is
             actually happening. The run's own session output does, and it was
             already streaming to the renderer the whole time. -->
        <MiniTerminal v-if="running && latest?.sessionId" :session-id="latest.sessionId" label="verifying" />

        <!-- What this run costs in time, learned from history — same rationale as
             verifyEstimate above; shown before the run, not only during it. -->
        <div v-if="verifyEstimateLine" class="prof-meta mono" data-testid="tests-estimate">
          {{ verifyEstimateLine
          }}<span v-if="verifyEstimate && !verifyEstimate.comparable"> — treat it loosely</span>
        </div>

        <!-- Suite picker: heavy suites are opt-in, and what the environment
             cannot run says so here rather than failing mid-run (FR-057). -->
        <div class="suites" data-testid="tests-suites">
          <template v-for="s in suites" :key="s.id">
            <button
              class="chip suite"
              :class="{ on: isSelected(s), dev: !!blockedReason(s) }"
              :disabled="!!blockedReason(s)"
              :title="blockedReason(s) ?? s.command"
              :data-testid="`tests-suite-${s.id}`"
              @click="toggleSuite(s)"
            >
              {{ s.label }}
              <span v-if="blockedReason(s)" class="dev-tag">{{ blockedReason(s) }}</span>
              <span v-else-if="s.heavy" class="heavy-tag mono">slow</span>
              <span v-if="commandOverrides[s.id]" class="heavy-tag mono">edited</span>
            </button>
            <!-- The catalogue's command is a guess about a conventional layout; this
                 is how it gets corrected without editing the app's source. -->
            <button
              class="chip cmd-edit mono"
              :data-testid="`tests-suite-edit-${s.id}`"
              :title="`Edit the command for ${s.label}`"
              @click="editCommand(s)"
            >
              ✎
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
          <!-- Only while a run is live: before this, a run the developer no longer
               wanted had to be waited out, and one whose session had died could
               only be cleared by restarting the app. -->
          <button
            v-if="running && latest"
            class="chip"
            data-testid="tests-cancel"
            title="Stop the session's current turn and close this run. It stops whatever the session is doing, not only the tests."
            @click="cancelVerify()"
          >
            Cancel
          </button>
          <button
            class="run"
            :disabled="verify.starting || running || (selected ?? []).length === 0"
            data-testid="tests-run"
            @click="runVerify()"
          >
            {{ running ? '● Running…' : '▷ Run verification' }}
          </button>
        </div>
        <div v-if="verify.error" class="err" data-testid="tests-error">{{ verify.error }}</div>
      </div>

      <!-- One headline figure over the six gates, and it is COUNTED: the share
           of gates this run measured that came back clean. What it left
           unmeasured is printed beside it rather than folded in, so the figure
           can never imply coverage the run did not have. -->
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

      <div class="gates">
        <button
          v-for="g in gates"
          :key="g.id"
          class="gate"
          :class="g.status"
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
          <span v-if="!t.built" class="dev-dot" title="In development">◌</span>
        </button>
      </div>

      <EvalsView
        v-if="subTab === 'qa'"
        :project-id="projectId"
        :project-name="projectName"
        @ran="emit('ran')"
        @run="(text) => emit('run', text)"
      />

      <!-- API eval set: chosen endpoints, called by the app, judged in code. -->
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

        <!-- The session's part of an API run is fetching real identifiers, which
             is the slow half and the half that silently fails. -->
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
        <!-- The deployed environment. Separate row because it is a different kind
             of thing: never started, never stopped, and the same eval set run
             against an API that already exists somewhere. -->
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
            {{ isPicked(e) ? '✓' : '+' }}
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
            {{ apiRunning ? '● Running…' : `▷ Run against ${apiTarget === 'qa' ? 'QA' : 'local'}` }}
          </button>
        </div>
        <div v-if="api.error" class="err" data-testid="tests-api-error">{{ api.error }}</div>

        <div class="targets">
          <span class="sec mono">EVAL SET</span>
          <span class="spacer"></span>
          <!-- The report is written from the recorded calls, so it is offered for
               any finished run rather than only the one just made. -->
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

      <!-- Results + evidence: what ran, and the proof it was executed. -->
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

      <!-- Coverage: the run's own figures, or nothing at all. -->
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

      <!-- Quality: architecture, mutation, and the external service's own gate. -->
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
/* The run's headline. A rule of its own above the tiles rather than a seventh
   tile: it is about the six, not one of them. */
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

/* Green only when every measured gate is clean. "Most of them" is not a pass. */
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
  /* Top, not centre: the offerings wrap to a second line now, and centring
     would float the stack's name against the middle of that block. */
  align-items: flex-start;
  gap: 12px;
  width: 100%;
  max-width: 840px;
  padding: 10px 13px;
  margin-bottom: 6px;
  text-align: left;
  background: var(--bg-hover);
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

/* Wraps. This is the list of what picking a stack actually gets you, and every
   one of the four was clipped mid-word against a pane that was two-thirds
   empty — an ellipsis where the answer to the question on screen should be. */
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
  max-width: 840px;
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

.heavy-tag {
  font-size: var(--fs-micro);
  color: var(--text-ghost);
}

/* The edit affordance rides beside its suite chip rather than inside it: the
   chip is the on/off target, and a control nested in it would swallow that. */
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

.run {
  flex-shrink: 0;
  padding: 6px 14px;
  font-size: var(--fs-meta);
  font-weight: var(--w-em);
  color: var(--green-ink);
  background: var(--gloss), linear-gradient(135deg, var(--green), var(--green2));
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
  grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
  gap: 7px;
  max-width: 840px;
  margin-bottom: 16px;
}

.gate {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 9px 11px;
  text-align: left;
  background: var(--bg-hover);
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

/* The mark that says the app read this figure out of the runner's own report file
   rather than off the session's summary. Deliberately quiet: it qualifies the
   figure, it is not the figure. */
.gate-verified {
  font-size: var(--fs-micro);
  letter-spacing: 0.05em;
  color: var(--green);
  opacity: 0.75;
}

.gate-value {
  font-size: var(--fs-title);
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

.gate.fail .gate-value {
  color: var(--red);
}

.gate.warn .gate-value {
  color: var(--amber);
}

.gate.none {
  opacity: 0.62;
}

/* Labels a suite the current environment cannot run (blockedReason). */
.dev-tag {
  font-size: var(--fs-micro);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--amber);
}

.sub-tabs {
  display: flex;
  gap: 2px;
  max-width: 840px;
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
  max-width: 840px;
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
  /* width + text-align because the pickable variant is a <button>: it had no
     keyboard path as a div, and a button is inline-block and centred by default. */
  width: 100%;
  text-align: left;
  padding: 6px 10px;
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
  background: var(--bg-hover);
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
  background: var(--bg-hover);
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

/* One real HTTP call: its verdict, the call, then the row it was drawn from. */
.ep {
  padding: 8px 10px;
  margin-bottom: 5px;
  background: var(--bg-hover);
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
  /* Same protection as .ep-line and .ev-result: this holds model-written prose
     that can carry an unbroken URL or stack frame, which would otherwise widen
     the row and push the panel into a horizontal scroll. */
  word-break: break-word;
}

/* The provenance lines: which server and query produced the identifiers, and
   what the response was checked against. Labelled so neither reads as prose. */
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
