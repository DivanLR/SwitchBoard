<script setup lang="ts">
// Tests section shell — the design's verify surface: pick the project's stack,
// choose what to verify, run it, then read the six gates and drill into a panel.
//
// Only what the app can actually produce is live. A gate whose figure nothing
// measures yet, and a panel with no data behind it, render greyed with an
// "in development" badge rather than showing a number we did not measure
// (spec 002 FR-072). The one fully-built panel is Manual QA, which is the eval
// loop (US7) — it keeps its own view.
import { computed, onMounted, ref, watch } from 'vue'
import { stackById, TEST_STACKS, VERIFY_GATES, type VerifyGate } from '@shared/test-catalog'
import { evals } from '@renderer/stores/evals'
import { useSettingsStore } from '@renderer/stores/settings'
import EvalsView from '@renderer/views/EvalsView.vue'

const props = defineProps<{ projectId: string; projectName: string; branch?: string | null }>()

const emit = defineEmits<{
  (e: 'ran'): void
  (e: 'run', text: string): void
}>()

const settingsStore = useSettingsStore()

type SubTab = 'coverage' | 'quality' | 'evidence' | 'qa' | 'skill'
const subTab = ref<SubTab>('qa')
/** What a run covers. Only the working tree is scoped today. */
const target = ref('tree')

// The shell owns the load: the picker needs detection before Manual QA (and so
// EvalsView) has mounted, and the gates need the lines.
onMounted(() => void evals.load(props.projectId))
watch(() => props.projectId, (id) => void evals.load(id))

const detected = computed(() => evals.suitesFor(props.projectId))
const chosenId = computed(() => settingsStore.settings?.projectTestStacks?.[props.projectId])
const stack = computed(() => stackById(chosenId.value))
const runs = computed(() => evals.listFor(props.projectId))

/** Detection is a hint, never a decision — the developer confirms it (FR-034). */
const detectHint = computed(() =>
  detected.value.length > 0
    ? `Looks like ${detected.value.map((s) => s.stackLabel).join(' + ')} from the project files — confirm that or pick another.`
    : 'Nothing conclusive in the project files — pick the stack yourself.',
)

function chooseStack(id: string): void {
  void settingsStore.save({
    projectTestStacks: { ...(settingsStore.settings?.projectTestStacks ?? {}), [props.projectId]: id },
  })
}

/**
 * A built gate's state comes from the acceptance lines whose check is one of that
 * gate's suites: failed beats unreported beats passed, so the tile never reads
 * greener than the evidence.
 */
function gateState(gate: VerifyGate): { status: string; value: string; sub: string } {
  if (!gate.built) return { status: 'dev', value: '—', sub: 'in development' }
  const commands = new Set(
    (stack.value?.suites ?? []).filter((s) => s.kind === gate.from).map((s) => s.command),
  )
  const own = runs.value.filter((r) => r.checkCmd && commands.has(r.checkCmd))
  if (own.length === 0) return { status: 'none', value: '—', sub: 'not run' }
  if (own.some((r) => r.checkStatus === 'fail')) return { status: 'fail', value: 'failed', sub: 'the check reported a failure' }
  if (own.some((r) => r.checkStatus === 'inconclusive')) {
    return { status: 'warn', value: 'inconclusive', sub: 'ran, proved nothing' }
  }
  const passed = own.filter((r) => r.checkStatus === 'pass').length
  if (passed === 0) return { status: 'none', value: '—', sub: `${own.length} line(s), not run` }
  return { status: 'pass', value: 'passed', sub: `${passed} of ${own.length} line(s)` }
}

const gates = computed(() => VERIFY_GATES.map((g) => ({ ...g, ...gateState(g) })))

/** The design's headings per panel — the shape of what goes there. */
const DEV_SECTIONS: Record<SubTab, string[]> = {
  coverage: ['LINE', 'CHANGED LINES', 'FILES YOU TOUCHED'],
  quality: ['QUALITY BAR', 'ARCHITECTURE', 'MUTATION TESTING', 'SONARQUBE · DUPLICATION · DEBT'],
  evidence: ['ACTUAL RUNS AGAINST THE BUILD', 'SCREENSHOTS FROM THE RUN'],
  qa: [],
  skill: ['TEST SKILL', 'WHAT A FULL RUN EXECUTES', 'GET IT IN FRONT OF YOU'],
}

const SUB_TABS: { id: SubTab; label: string; built: boolean }[] = [
  { id: 'coverage', label: 'Coverage', built: false },
  { id: 'quality', label: 'Quality', built: false },
  { id: 'evidence', label: 'Evidence', built: false },
  { id: 'qa', label: 'Manual QA', built: true },
  { id: 'skill', label: 'Skill', built: false },
]

const subTabs = computed(() =>
  SUB_TABS.map((t) => ({
    ...t,
    // Manual QA carries the count of lines still waiting on a verdict.
    badge: t.id === 'qa' ? runs.value.filter((r) => r.verdict === 'pending').length : 0,
  })),
)

/** Run every suite the chosen stack offers, as one session request. */
function runVerify(): void {
  const suites = stack.value?.suites ?? []
  if (suites.length === 0) return
  emit(
    'run',
    `Verify the working tree for this project against its ${stack.value?.label} stack.\n\n` +
      suites.map((s) => `- ${s.label}: ${s.command}`).join('\n') +
      '\n\nRun each in turn and report, per suite, whether it passed and what failed. ' +
      'Do not fix anything — this is a verification pass.',
  )
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
          <span class="prof-sub mono">{{ stack.suites.length }} suites</span>
          <span style="flex: 1"></span>
          <button class="link" data-testid="tests-change-stack" @click="chooseStack('')">change stack</button>
        </div>
        <div class="prof-meta mono">
          {{ branch ? `on ${branch}` : 'no branch' }} · verification runs through the session, never as
          its own process
        </div>

        <div class="targets">
          <span class="lbl">verify</span>
          <button class="chip" :class="{ on: target === 'tree' }" data-testid="tests-target-tree" @click="target = 'tree'">
            Working tree
          </button>
          <button class="chip dev" disabled title="Not built yet" data-testid="tests-target-head">
            Last commit <span class="dev-tag">in development</span>
          </button>
          <button class="chip dev" disabled title="Not built yet" data-testid="tests-target-spec">
            Spec criteria <span class="dev-tag">in development</span>
          </button>
          <span style="flex: 1"></span>
          <button class="run" data-testid="tests-run" @click="runVerify()">▷ Run verification</button>
        </div>
      </div>

      <!-- The six gates. -->
      <div class="gates">
        <button
          v-for="g in gates"
          :key="g.id"
          class="gate"
          :class="[g.status, { dev: !g.built }]"
          :data-testid="`tests-gate-${g.id}`"
          :disabled="!g.built"
          :title="g.built ? `Target: ${g.target}` : 'Nothing measures this yet'"
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

      <div v-else class="dev-panel" :data-testid="`tests-dev-${subTab}`">
        <div class="dev-badge">in development</div>
        <div class="dev-title">
          {{ subTab === 'coverage' ? 'Coverage' : subTab === 'quality' ? 'Quality' : subTab === 'evidence' ? 'Evidence' : 'Verify skill' }}
        </div>
        <!-- The design's own section headings, so the shape of each panel is
             legible even while its contents are unbuilt. -->
        <div class="dev-sections mono">
          <span v-for="h in DEV_SECTIONS[subTab]" :key="h" class="dev-section">{{ h }}</span>
        </div>
        <div class="dev-body">
          <template v-if="subTab === 'coverage'">
            Line and branch coverage, the share of changed lines exercised, and the files you
            touched ranked by how little of them a test reaches. The suites that emit coverage are
            already in this project's stack — nothing reads their report yet, so no figure is shown
            rather than one we did not measure.
          </template>
          <template v-else-if="subTab === 'quality'">
            The quality bar with each threshold met or missed, architecture rules naming the
            offending component, mutation testing with the surviving mutants, and the SonarQube gate,
            grades, duplication and debt via its MCP. Running the architecture suite works today;
            parsing rules, mutants and the service report does not.
          </template>
          <template v-else-if="subTab === 'evidence'">
            Actual runs against the build — real inputs and the results they produced — plus the
            screenshots from the run. Every artefact has to be the product of executing the code, so
            this stays empty until that runs.
          </template>
          <template v-else>
            A generated test skill for this stack: what a full run executes, the harness that gets
            it in front of you, and the gates it knows. The static stack catalogue does that job
            today; generating a per-project skill does not exist yet.
          </template>
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
  border: 1px solid rgba(63, 178, 127, 0.32);
  background: rgba(63, 178, 127, 0.1);
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

.targets {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 11px;
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

.chip.on {
  color: var(--green);
  border-color: rgba(63, 178, 127, 0.5);
  background: rgba(63, 178, 127, 0.1);
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

.gate:hover:not(:disabled) {
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

/* Not-built treatment: readable, obviously inert, and labelled. */
.gate.dev,
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
  border: 1px solid rgba(201, 145, 63, 0.4);
  background: rgba(201, 145, 63, 0.08);
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
