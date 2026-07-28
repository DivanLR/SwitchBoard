<script setup lang="ts">
// Tests section — the eval loop for small changes (spec 002 US7, FR-086..FR-092).
// A change is one observable acceptance line plus the check that proves it; the
// verdict and the 1-5 rating are the developer's own and are the whole record.
// Nothing here spawns a process: the check and the manual pass both go through
// the session like Cleanup does (FR-041), so output lands in the Session tab.
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { canPassEval, evalStage, EVAL_RELOOP_RATING, type EvalRun } from '@shared/domain'
import type { TestSuite } from '@shared/test-catalog'
import { evals } from '@renderer/stores/evals'

const props = defineProps<{ projectId: string; projectName: string }>()

const emit = defineEmits<{
  /** A dispatch went to the session — the caller switches to the Session tab. */
  (e: 'ran'): void
  /** Run text in the session (the manual pass hands over a prompt, not a check). */
  (e: 'run', text: string): void
}>()

const acceptance = ref('')
const checkCmd = ref('')
const showSuites = ref(false)

const runs = computed(() => evals.listFor(props.projectId))
const ratings = computed(() => runs.value.map((r) => r.rating).filter((r): r is number => r != null))
// Only over rated rows — an unrated row is not a zero.
const meanRating = computed(() =>
  ratings.value.length === 0
    ? null
    : Math.round((ratings.value.reduce((sum, r) => sum + r, 0) / ratings.value.length) * 10) / 10,
)

const suites = computed(() => evals.suitesFor(props.projectId))

onMounted(() => {
  void evals.load(props.projectId)
  // The gate result arrives from the session, not from a click.
  stopPush = window.switchboard.on('push.evalsChanged', (push) => {
    evals.applyPush(push.projectId, push.runs)
  })
})
let stopPush: (() => void) | null = null
onUnmounted(() => stopPush?.())
watch(() => props.projectId, (id) => void evals.load(id))

async function add(): Promise<void> {
  if (!acceptance.value.trim()) return
  await evals.add(props.projectId, acceptance.value, checkCmd.value)
  if (!evals.error) {
    acceptance.value = ''
    checkCmd.value = ''
  }
}

/** A suite from the project's own tooling becomes a line, check pre-filled. */
async function addFromSuite(suite: TestSuite): Promise<void> {
  await evals.add(props.projectId, suite.acceptance, suite.command)
  showSuites.value = false
}

// Implement / verify / review all run through the session; its output decides the
// check outcome (the app never claims a result the session did not report).
async function dispatch(run: EvalRun, kind: 'check' | 'attempts' | 'judge'): Promise<void> {
  await evals.dispatch(props.projectId, run.id, kind)
  if (!evals.error) emit('ran')
}

// The manual pass: launch the app and hand over the acceptance line as what to
// look at (FR-088). A prompt, not a command — the session decides how to launch.
function manualPass(run: EvalRun): void {
  emit(
    'run',
    `Manual pass for this acceptance line: "${run.acceptance}"\n` +
      'Launch the app in the background (npm run dev), screenshot the affected screen ' +
      'with Playwright first, then tell me in at most 4 lines what to click, what to ' +
      'look for, and the one thing most likely to be wrong.',
  )
}

function needsReloop(run: EvalRun): boolean {
  return run.rating != null && run.rating <= EVAL_RELOOP_RATING
}

const STAGE_HINT: Record<string, string> = {
  implement: 'built — nothing verified yet',
  verify: 'the check has reported',
  review: 'judged — your call next',
  done: 'recorded',
}

const shortDate = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
</script>

<template>
  <div class="evals" data-testid="evals-view">
    <div class="intro">
      One observable line per small change — implement (one run, or several isolated attempts), let
      the check report, judge it, then record a verdict and a rating. A pass needs the check to have
      passed.
      <span class="gate">
        More than a handful of files, an acceptance that will not fit in three sentences, or a
        stored-data change → use <span class="mono">/speckit-specify</span> instead.
      </span>
    </div>

    <div class="add">
      <input
        v-model="acceptance"
        class="in"
        data-testid="eval-acceptance"
        placeholder="What is observably true when it works — a testid, a label, a status"
        @keydown.enter="add()"
      />
      <input
        v-model="checkCmd"
        class="in mono check"
        data-testid="eval-check"
        placeholder="Check that proves it (optional) — npx vitest run tests/unit/x.spec.ts"
        @keydown.enter="add()"
      />
      <button class="add-btn" data-testid="eval-add" :disabled="!acceptance.trim()" @click="add()">
        + Add line
      </button>
      <button class="act" data-testid="eval-suites-toggle" @click="showSuites = !showSuites">
        {{ showSuites ? '▾' : '▸' }} From a suite
      </button>
    </div>
    <div v-if="evals.error" class="err" data-testid="eval-error">{{ evals.error }}</div>

    <!-- What this project can be tested with, from its own tooling. -->
    <div v-if="showSuites" class="suites" data-testid="eval-suites">
      <div v-if="suites.length === 0" class="empty">
        No known stack detected in this project's root — write the check by hand above.
      </div>
      <div v-for="stack in suites" :key="stack.stackId" class="stack">
        <div class="stack-head mono">{{ stack.stackLabel }}</div>
        <button
          v-for="s in stack.suites"
          :key="s.id"
          class="suite-row"
          :data-testid="`eval-suite-${s.id}`"
          @click="addFromSuite(s)"
        >
          <span class="suite-kind" :class="s.kind">{{ s.kind }}</span>
          <span class="suite-label">{{ s.label }}</span>
          <span class="suite-cmd mono">{{ s.command }}</span>
        </button>
      </div>
    </div>

    <div class="summary mono">
      <span data-testid="eval-count">{{ runs.length }} line{{ runs.length === 1 ? '' : 's' }}</span>
      <span v-if="meanRating != null" data-testid="eval-mean">· mean rating {{ meanRating }}/5</span>
    </div>

    <div v-if="runs.length === 0" class="empty">
      Nothing recorded yet. Write the line first, then the check that fails.
    </div>

    <div v-for="run in runs" :key="run.id" class="row" :data-testid="`eval-row-${run.id}`">
      <div class="row-head">
        <span class="stage" :class="evalStage(run)" :data-testid="`eval-stage-${run.id}`">
          {{ evalStage(run) }}
        </span>
        <span class="acc">{{ run.acceptance }}</span>
        <span class="when mono">{{ shortDate(run.createdAt) }}</span>
        <button class="del" :data-testid="`eval-remove-${run.id}`" title="Remove" @click="evals.remove(projectId, run.id)">
          ✕
        </button>
      </div>

      <div class="row-meta">
        <span class="chip" :class="run.checkStatus" :data-testid="`eval-check-status-${run.id}`">
          {{ run.checkStatus === 'not_run' ? 'check not run' : `check ${run.checkStatus}` }}
        </span>
        <span v-if="run.attempts > 1" class="chip" :data-testid="`eval-attempts-chip-${run.id}`">
          {{ run.attempts }} attempts
        </span>
        <span v-if="run.checkCmd" class="cmd mono">{{ run.checkCmd }}</span>
        <span v-else class="cmd mono none">no check — the manual pass is the check</span>
      </div>

      <div v-if="run.judge" class="judge" :data-testid="`eval-judge-${run.id}`">
        <span class="lbl">judge</span> {{ run.judge }}
      </div>

      <div class="row-actions">
        <button
          v-if="run.checkCmd"
          class="act"
          :data-testid="`eval-run-check-${run.id}`"
          @click="dispatch(run, 'check')"
        >
          ▷ Run check
        </button>
        <button class="act" :data-testid="`eval-manual-${run.id}`" @click="manualPass(run)">
          ◱ Launch &amp; look
        </button>
        <button class="act" :data-testid="`eval-attempts-run-${run.id}`" @click="dispatch(run, 'attempts')">
          ⑃ {{ run.attempts === 1 ? 'Implement' : `${run.attempts} attempts` }}
        </button>
        <button class="act" :data-testid="`eval-judge-run-${run.id}`" @click="dispatch(run, 'judge')">
          ⚖ Judge
        </button>
        <span class="sep"></span>
        <span class="lbl">attempts</span>
        <button
          v-for="n in 3"
          :key="n"
          class="act sm"
          :class="{ on: run.attempts === n }"
          :data-testid="`eval-attempts-${run.id}-${n}`"
          :title="n === 1 ? 'One straight run' : `${n} isolated attempts, keep the winner`"
          @click="evals.record(projectId, run.id, { attempts: n })"
        >
          {{ n }}
        </button>
      </div>

      <div class="row-verdict">
        <span class="lbl">verdict</span>
        <button
          class="act sm"
          :class="{ on: run.verdict === 'pass' }"
          :disabled="!canPassEval(run)"
          :data-testid="`eval-verdict-pass-${run.id}`"
          :title="canPassEval(run) ? 'Record this as done' : 'The check has not passed yet'"
          @click="evals.record(projectId, run.id, { verdict: 'pass' })"
        >
          pass
        </button>
        <span v-if="!canPassEval(run)" class="gated" :data-testid="`eval-gated-${run.id}`">
          gated — {{ STAGE_HINT[evalStage(run)] }}
        </span>
        <button
          class="act sm"
          :class="{ bad: run.verdict === 'fail' }"
          :data-testid="`eval-verdict-fail-${run.id}`"
          @click="evals.record(projectId, run.id, { verdict: 'fail' })"
        >
          fail
        </button>

        <span class="sep"></span>
        <span class="lbl">rating</span>
        <button
          v-for="n in 5"
          :key="n"
          class="star"
          :class="{ lit: run.rating != null && n <= run.rating }"
          :data-testid="`eval-rate-${run.id}-${n}`"
          :title="`${n} of 5`"
          @click="evals.record(projectId, run.id, { rating: run.rating === n ? null : n })"
        >
          ★
        </button>
        <span v-if="needsReloop(run)" class="reloop" :data-testid="`eval-reloop-${run.id}`">
          needs another loop — tighten the check
        </span>
      </div>

      <input
        class="in note"
        :data-testid="`eval-note-${run.id}`"
        :value="run.note ?? ''"
        placeholder="Note (optional)"
        @change="evals.record(projectId, run.id, { note: ($event.target as HTMLInputElement).value })"
      />
    </div>
  </div>
</template>

<style scoped>
.evals {
  flex: 1;
  overflow-y: auto;
  padding: 18px 22px 52px;
}

.intro {
  max-width: 840px;
  font-size: 12.8px;
  line-height: 1.6;
  color: var(--text-mid);
  margin-bottom: 16px;
  text-wrap: pretty;
}

.intro .gate {
  display: block;
  margin-top: 6px;
  font-size: 11.5px;
  color: var(--text-faint);
}

.add {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  max-width: 840px;
  margin-bottom: 8px;
}

.in {
  flex: 1 1 100%;
  min-width: 0;
  padding: 8px 11px;
  font-size: 12.5px;
  color: var(--text-body);
  background: var(--bg-hover);
  border: 1px solid var(--border-card);
  border-radius: var(--rc);
}

.in:focus {
  outline: none;
  border-color: var(--green);
}

.in.check {
  flex: 1 1 60%;
  font-size: 11.5px;
}

.add-btn {
  flex: 0 0 auto;
  padding: 8px 15px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--green-ink);
  background: var(--gloss), linear-gradient(135deg, var(--green), var(--green2));
  border-radius: var(--rc);
  box-shadow: var(--green-glow);
  cursor: pointer;
}

.add-btn:disabled {
  opacity: 0.5;
  cursor: default;
  box-shadow: none;
}

.err {
  max-width: 840px;
  margin-bottom: 8px;
  font-size: 11.5px;
  color: var(--red);
}

.summary {
  max-width: 840px;
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
  font-size: 10.5px;
  color: var(--text-faint);
}

.empty {
  max-width: 840px;
  font-size: 12px;
  color: var(--text-faint);
}

.row {
  max-width: 840px;
  padding: 11px 13px;
  margin-bottom: 9px;
  background: var(--bg-hover);
  box-shadow: var(--elev);
  border: 1px solid var(--border-card);
  border-radius: var(--rc);
}

.row-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.acc {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  color: var(--text-bright);
  text-wrap: pretty;
}

.when {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--text-faint);
}

.del {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-faint);
  cursor: pointer;
}

.del:hover {
  color: var(--red);
}

.row-meta {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-top: 7px;
}

.chip {
  flex-shrink: 0;
  font-size: 10px;
  border-radius: 99px;
  padding: 1px 9px;
  white-space: nowrap;
  color: var(--text-faint);
  border: 1px solid var(--border-strong);
}

/* CIV stage of the line: implement → verify → review → done. */
.stage {
  flex-shrink: 0;
  font-family: var(--mono);
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  border-radius: 99px;
  padding: 2px 8px;
  color: var(--text-faint);
  border: 1px solid var(--border-strong);
}

.stage.verify {
  color: var(--blue);
  border-color: color-mix(in srgb, var(--blue) 40%, transparent);
}

.stage.review {
  color: var(--amber);
  border-color: color-mix(in srgb, var(--amber) 50%, transparent);
}

.stage.done {
  color: var(--green);
  border-color: color-mix(in srgb, var(--green) 32%, transparent);
}

.judge {
  margin-top: 8px;
  padding: 7px 9px;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--text-mid);
  background: color-mix(in srgb, var(--amber) 7%, transparent);
  /* 1px: same refused side-tab pattern as StreamEvent's prompt callout. */
  border-left: 1px solid var(--amber);
  border-radius: 3px;
  text-wrap: pretty;
}

.gated {
  font-size: 10.5px;
  color: var(--text-faint);
}

.act:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* Suites the project's own tooling provides (API / unit / UI / coverage). */
.suites {
  max-width: 840px;
  margin-bottom: 14px;
}

.stack {
  margin-bottom: 10px;
}

.stack-head {
  font-size: 10.5px;
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 5px;
}

.suite-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 7px 11px;
  margin-bottom: 5px;
  text-align: left;
  background: var(--bg-hover);
  border: 1px solid var(--border-card);
  border-radius: var(--rc);
  cursor: pointer;
}

.suite-row:hover {
  border-color: var(--green);
}

.suite-kind {
  flex-shrink: 0;
  width: 62px;
  font-family: var(--mono);
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-faint);
}

.suite-kind.api {
  color: var(--blue);
}

.suite-kind.ui {
  color: var(--amber);
}

.suite-kind.unit {
  color: var(--green);
}

.suite-label {
  flex-shrink: 0;
  width: 190px;
  font-size: 11.5px;
  color: var(--text-body);
}

.suite-cmd {
  flex: 1;
  min-width: 0;
  font-size: 10.5px;
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chip.pass {
  color: var(--green);
  background: color-mix(in srgb, var(--green) 10%, transparent);
  border-color: color-mix(in srgb, var(--green) 32%, transparent);
}

.chip.fail {
  color: var(--red);
  background: color-mix(in srgb, var(--red) 10%, transparent);
  border-color: color-mix(in srgb, var(--red) 32%, transparent);
}

.cmd {
  flex: 1;
  min-width: 0;
  font-size: 10.5px;
  color: var(--text-mid);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cmd.none {
  color: var(--text-faint);
}

.row-actions,
.row-verdict {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 9px;
}

.lbl {
  font-size: 10px;
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.sep {
  width: 1px;
  height: 14px;
  margin: 0 5px;
  background: var(--border-strong);
}

.act {
  padding: 4px 10px;
  font-size: 11px;
  color: var(--text-body);
  background: transparent;
  border: 1px solid var(--border-strong);
  border-radius: var(--rc);
  cursor: pointer;
}

.act:hover {
  border-color: var(--green);
}

.act.sm {
  padding: 2px 9px;
  font-size: 10.5px;
}

.act.on {
  color: var(--green);
  border-color: color-mix(in srgb, var(--green) 50%, transparent);
  background: color-mix(in srgb, var(--green) 10%, transparent);
}

.act.bad {
  color: var(--red);
  border-color: color-mix(in srgb, var(--red) 50%, transparent);
  background: color-mix(in srgb, var(--red) 10%, transparent);
}

.star {
  font-size: 13px;
  line-height: 1;
  color: var(--border-strong);
  cursor: pointer;
}

.star.lit {
  color: var(--amber);
}

.reloop {
  font-size: 10.5px;
  color: var(--amber);
}

.in.note {
  flex: 1 1 100%;
  margin-top: 9px;
  padding: 5px 9px;
  font-size: 11.5px;
}
</style>
