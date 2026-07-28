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
  VERIFY_GATES,
  type SandboxEnv,
  type TestSuite,
  type VerifyGate,
} from '@shared/test-catalog'
import type { Measured, VerifyRun } from '@shared/domain'
import { evals } from '@renderer/stores/evals'
import { verify } from '@renderer/stores/verify'
import { useProjectsStore } from '@renderer/stores/projects'
import { useSettingsStore } from '@renderer/stores/settings'
import EvalsView from '@renderer/views/EvalsView.vue'

const props = defineProps<{ projectId: string; projectName: string; branch?: string | null }>()

const emit = defineEmits<{
  (e: 'ran'): void
  (e: 'run', text: string): void
}>()

const settingsStore = useSettingsStore()
const projectsStore = useProjectsStore()

type SubTab = 'coverage' | 'quality' | 'evidence' | 'qa' | 'skill'
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
onMounted(() => {
  void evals.load(props.projectId)
  void verify.load(props.projectId)
  // The report arrives from the session, not from a click.
  stopPush = window.switchboard.on('push.verifyChanged', (push) => {
    verify.applyPush(push.projectId, push.runs)
  })
})
onUnmounted(() => stopPush?.())
watch(
  () => props.projectId,
  (id) => {
    selected.value = null
    void evals.load(id)
    void verify.load(id)
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

const suites = computed<TestSuite[]>(() => [...(stack.value?.suites ?? [])])
const blockedReason = (suite: TestSuite): string | null => unavailableReason(suite, sandboxed.value)

// The default selection follows the environment: heavy suites are opt-in, and a
// suite this environment cannot run starts unticked instead of failing later.
watch(
  [suites, sandboxed],
  ([list, sandbox]) => {
    if (list.length === 0) selected.value = null
    else if (selected.value === null) selected.value = defaultSelection(list, sandbox)
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

// --- Gates -------------------------------------------------------------------

/** What a tile shows once the run has (or has not) measured it. */
interface GateFace {
  status: 'pass' | 'fail' | 'warn' | 'none'
  value: string
  sub: string
}

type GateView = VerifyGate & GateFace

/** The figure nothing measured — rendered as "—" everywhere it appears. */
const unmeasured: Measured = { value: null, source: null }

const round = (n: number): number => Math.round(n * 10) / 10
const pct = (m: Measured): string => (m.value === null ? '—' : `${round(m.value)}%`)
const sourceOf = (m: Measured, fallback = 'nothing measured it'): string => m.source ?? fallback

/** Suites of the latest run whose catalog kind matches, ignoring ones that never
 *  executed — a skipped suite is not a pass and not a failure. */
function suiteGate(kinds: readonly string[]): GateFace {
  const results = (latest.value?.report?.suites ?? []).filter((r) => {
    const kind = suiteById(r.id)?.kind
    return kind !== undefined && kinds.includes(kind)
  })
  const executed = results.filter((r) => r.status === 'pass' || r.status === 'fail')
  if (executed.length === 0) {
    const skipped = results.find((r) => r.status === 'skipped' || r.status === 'unavailable')
    if (skipped) return { status: 'warn', value: 'skipped', sub: skipped.detail || 'not run here' }
    return { status: 'none', value: '—', sub: latest.value ? 'not in this run' : 'no run yet' }
  }
  const failed = executed.filter((r) => r.status === 'fail')
  if (failed.length > 0) {
    return { status: 'fail', value: 'failed', sub: failed[0].detail || `${failed.length} suite(s) failed` }
  }
  return { status: 'pass', value: 'passed', sub: `${executed.length} suite(s)` }
}

/** A measured figure against its threshold. Under target is a warning, never a
 *  failure: quality never flips a run's verdict (FR-071). */
function figureGate(m: Measured, minimum: number, sub?: string): GateFace {
  if (m.value === null) {
    return { status: 'none', value: '—', sub: latest.value ? 'not measured in this run' : 'no run yet' }
  }
  return {
    status: m.value >= minimum ? 'pass' : 'warn',
    value: pct(m),
    sub: sub ?? sourceOf(m),
  }
}

const gates = computed<GateView[]>(() =>
  VERIFY_GATES.map((gate) => {
    const report = latest.value?.report
    const quality = report?.quality
    switch (gate.id) {
      case 'unit':
        return { ...gate, ...suiteGate(['unit']) }
      case 'integration':
        return { ...gate, ...suiteGate(['api']) }
      case 'architecture': {
        const violations = quality?.archViolations
        if (!violations || violations.value === null) return { ...gate, ...suiteGate(['quality']) }
        return {
          ...gate,
          status: violations.value === 0 ? 'pass' : 'fail',
          value: String(violations.value),
          sub: violations.value === 0 ? sourceOf(violations) : quality?.findings[0] ?? 'rule violations',
        }
      }
      case 'mutation':
        return { ...gate, ...figureGate(quality?.mutation ?? unmeasured, 70) }
      case 'coverage': {
        const changed = quality ? report?.coverage.changed : null
        const line = report?.coverage.line ?? unmeasured
        if (changed && changed.value !== null) {
          return { ...gate, ...figureGate(changed, 90, `${pct(changed)} of changed lines · line ${pct(line)}`) }
        }
        return { ...gate, ...figureGate(line, 80) }
      }
      default: {
        if (!quality?.gate || quality.gate === 'not_configured') {
          return {
            ...gate,
            status: 'none',
            value: '—',
            sub: latest.value ? 'no quality service connected' : 'no run yet',
          }
        }
        const dup = quality.duplication
        return {
          ...gate,
          status: quality.gate === 'pass' ? 'pass' : 'fail',
          value: quality.gate === 'pass' ? 'passed' : 'failed',
          sub: `${quality.gateSource ?? 'quality service'}${dup.value === null ? '' : ` · ${pct(dup)} duplication`}`,
        }
      }
    }
  }),
)

// --- Run ---------------------------------------------------------------------

const SUB_TABS: { id: SubTab; label: string; built: boolean }[] = [
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

const report = computed(() => latest.value?.report ?? null)
const evidence = computed(() => report.value?.evidence ?? [])

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

function statusWord(run: VerifyRun): string {
  return run.status === 'running' ? 'running' : run.status
}
</script>

<template>
  <div class="tests" data-testid="tests-view">
    <!-- No stack chosen yet: the picker, seeded by detection. -->
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
          <span class="prof-name">{{ stack.label }}</span>
          <span class="prof-sub mono">{{ (selected ?? []).length }} of {{ stack.suites.length }} suites</span>
          <span style="flex: 1"></span>
          <button class="link" data-testid="tests-change-stack" @click="chooseStack('')">change stack</button>
        </div>
        <div class="prof-meta mono">
          {{ branch ? `on ${branch}` : 'no branch' }} · verification runs through the session, never as
          its own process
        </div>

        <!-- Suite picker: heavy suites are opt-in, and what the environment
             cannot run says so here rather than failing mid-run (FR-057). -->
        <div class="suites" data-testid="tests-suites">
          <button
            v-for="s in suites"
            :key="s.id"
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
          </button>
        </div>

        <div class="targets">
          <span class="lbl">verify</span>
          <button class="chip on" data-testid="tests-target-tree">Working tree</button>
          <button class="chip dev" disabled title="Not built yet" data-testid="tests-target-head">
            Last commit <span class="dev-tag">in development</span>
          </button>
          <button class="chip dev" disabled title="Not built yet" data-testid="tests-target-spec">
            Spec criteria <span class="dev-tag">in development</span>
          </button>
          <span style="flex: 1"></span>
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

      <!-- The six gates. -->
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
          <span class="gate-value">{{ g.value }}</span>
          <span class="gate-sub">{{ g.sub }}</span>
          <span class="gate-target mono">{{ g.target }}</span>
        </button>
      </div>

      <!-- Panels. -->
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

        <div class="sec mono">ACTUAL RUNS AGAINST THE BUILD</div>
        <p v-if="evidence.length === 0" class="empty">
          No evidence captured. "Capture evidence" executes the changed code and records the real
          inputs and the real results — nothing here is ever written from reading the code.
        </p>
        <div v-for="(e, i) in evidence" :key="i" class="ev" :data-testid="`tests-evidence-${i}`">
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
            <span class="fig-value">{{ report?.quality.gate === 'not_configured' ? 'not connected' : (report?.quality.gate ?? '—') }}</span>
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
            <span class="fig-src mono">{{ report?.quality.debt ? (report?.quality.gateSource ?? 'quality service') : 'nothing measured it' }}</span>
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
        <div v-for="(f, i) in report?.quality.findings ?? []" :key="i" class="row">
          <span class="row-status mono fail">rule</span>
          <span class="row-name">{{ f }}</span>
        </div>

        <div class="sec mono">SURVIVING MUTANTS</div>
        <p v-if="!report?.quality.survivors.length" class="empty">
          No surviving mutants reported. Mutation testing is a slow suite — tick it above to include
          it in a run.
        </p>
        <div v-for="(s, i) in report?.quality.survivors ?? []" :key="i" class="row">
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
.tests {
  flex: 1;
  overflow-y: auto;
  padding: 18px 22px 52px;
}

.intro {
  max-width: 840px;
  font-size: 12.8px;
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
  font-size: 11.5px;
  color: var(--text-faint);
}

.stack-row {
  display: flex;
  align-items: center;
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
  font-size: 12.5px;
  color: var(--text-bright);
}

.stack-sub {
  flex: 1;
  min-width: 0;
  font-size: 10.5px;
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.det {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--green);
  border: 1px solid color-mix(in srgb, var(--green) 32%, transparent);
  background: color-mix(in srgb, var(--green) 10%, transparent);
  border-radius: 99px;
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
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text-bright);
}

.prof-sub,
.prof-meta {
  font-size: 10.5px;
  color: var(--text-faint);
}

.prof-meta {
  margin-top: 3px;
}

.link {
  font-size: 10.5px;
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
  font-size: 10px;
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  font-size: 11px;
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
  font-size: 9px;
  color: var(--text-ghost);
}

.run {
  flex-shrink: 0;
  padding: 6px 14px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--green-ink);
  background: var(--gloss), linear-gradient(135deg, var(--green), var(--green2));
  border-radius: var(--rc);
  box-shadow: var(--green-glow);
  cursor: pointer;
}

.run:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.err {
  margin-top: 8px;
  font-size: 11.5px;
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
  font-size: 9.5px;
  letter-spacing: 0.05em;
  color: var(--text-faint);
}

.gate-value {
  font-size: 14px;
  color: var(--text-bright);
}

.gate-sub {
  font-size: 10.5px;
  color: var(--text-mid);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gate-target {
  margin-top: 3px;
  font-size: 9.5px;
  color: var(--text-ghost);
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

/* Not-built treatment: readable, obviously inert, and labelled. */
.chip.dev {
  opacity: 0.45;
  cursor: not-allowed;
  border-style: dashed;
}

.dev-tag {
  font-size: 9px;
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
  font-size: 11.5px;
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
  font-size: 9.5px;
  color: var(--green-ink);
  background: var(--green);
  border-radius: 99px;
  padding: 0 5px;
}

.dev-dot {
  font-size: 9px;
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
  font-size: 13px;
  color: var(--text-bright);
}

.panel-meta {
  flex: 1;
  min-width: 0;
  font-size: 10.5px;
  color: var(--text-faint);
}

.verdict {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  border-radius: 99px;
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
  font-size: 11.5px;
  color: var(--amber);
  margin-bottom: 10px;
}

.empty {
  max-width: 620px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-faint);
  margin-bottom: 10px;
  text-wrap: pretty;
}

.row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 6px 10px;
  margin-bottom: 4px;
  background: var(--bg-hover);
  border: 1px solid var(--border-card);
  border-radius: var(--rc);
}

.row-status {
  flex-shrink: 0;
  width: 78px;
  font-size: 10px;
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
  font-size: 12px;
  color: var(--text-body);
}

.row-detail {
  flex: 1;
  min-width: 0;
  font-size: 10.5px;
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sec {
  font-size: 9.5px;
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
  font-size: 9.5px;
  letter-spacing: 0.05em;
  color: var(--text-faint);
}

.fig-value {
  font-size: 15px;
  color: var(--text-bright);
}

.fig-src {
  font-size: 9.5px;
  color: var(--text-ghost);
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
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-faint);
}

.ev-body {
  flex: 1;
  min-width: 0;
}

.ev-what {
  font-size: 12px;
  color: var(--text-body);
}

.ev-result {
  font-size: 10.5px;
  color: var(--text-mid);
  margin-top: 2px;
  white-space: pre-wrap;
  word-break: break-word;
}

.ev-path {
  font-size: 9.5px;
  color: var(--text-ghost);
  margin-top: 3px;
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
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--amber);
  border: 1px solid color-mix(in srgb, var(--amber) 40%, transparent);
  background: color-mix(in srgb, var(--amber) 8%, transparent);
  border-radius: 99px;
  padding: 1px 9px;
}

.dev-title {
  font-size: 13px;
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
  font-size: 9.5px;
  letter-spacing: 0.05em;
  color: var(--text-ghost);
  border: 1px dashed var(--border-strong);
  border-radius: 99px;
  padding: 1px 8px;
}

.dev-body {
  max-width: 620px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-mid);
  text-wrap: pretty;
}
</style>
