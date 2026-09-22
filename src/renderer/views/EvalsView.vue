<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { canPassEval, evalStage, EVAL_RELOOP_RATING, type EvalRun } from '@shared/domain'
import type { TestSuite } from '@shared/test-catalog'
import { useEvalsStore } from '@renderer/stores/evals'
import Icon from '@renderer/components/Icon.vue'

const evals = useEvalsStore()

const props = defineProps<{ projectId: string; projectName: string }>()

const emit = defineEmits<{
  (e: 'ran'): void
  (e: 'run', text: string): void
}>()

const acceptance = ref('')
const checkCmd = ref('')
const showSuites = ref(false)

const runs = computed(() => evals.listFor(props.projectId))
const ratings = computed(() => runs.value.map((r) => r.rating).filter((r): r is number => r != null))
const meanRating = computed(() =>
  ratings.value.length === 0
    ? null
    : Math.round((ratings.value.reduce((sum, r) => sum + r, 0) / ratings.value.length) * 10) / 10,
)

const decided = computed(() => runs.value.filter((r) => r.verdict !== 'pending'))
const passRate = computed(() =>
  decided.value.length === 0
    ? null
    : Math.round((decided.value.filter((r) => r.verdict === 'pass').length / decided.value.length) * 100),
)

const suites = computed(() => evals.suitesFor(props.projectId))

let stopPush: (() => void) | null = null
onMounted(() => {
  void evals.load(props.projectId)
  stopPush = window.switchboard.on('push.evalsChanged', (push) => {
    evals.applyPush(push.projectId, push.runs)
  })
})
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

async function addFromSuite(suite: TestSuite): Promise<void> {
  await evals.add(props.projectId, suite.acceptance, suite.command)
  showSuites.value = false
}

async function dispatch(run: EvalRun, kind: 'check' | 'attempts' | 'judge'): Promise<void> {
  await evals.dispatch(props.projectId, run.id, kind)
  if (!evals.error) emit('ran')
}

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
  <div class="ui-body" data-testid="evals-view">
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
        <Icon :name="showSuites ? 'chevron-down' : 'chevron-right'" :size="12" /> From a suite
      </button>
    </div>
    <div v-if="evals.error" class="ui-err" data-testid="eval-error">{{ evals.error }}</div>

    <div v-if="showSuites" class="suites" data-testid="eval-suites">
      <div v-if="suites.length === 0" class="ui-empty-line">
        No known stack detected in this project's root — write the check by hand above.
      </div>
      <div v-for="stack in suites" :key="stack.stackId" class="stack">
        <div class="ui-kicker">{{ stack.stackLabel }}</div>
        <button
          v-for="s in stack.suites"
          :key="s.id"
          class="ui-row suite-row"
          :data-testid="`eval-suite-${s.id}`"
          @click="addFromSuite(s)"
        >
          <span class="suite-kind" :class="s.kind">{{ s.kind }}</span>
          <span class="suite-label">{{ s.label }}</span>
          <span class="suite-cmd mono">{{ s.command }}</span>
        </button>
      </div>
    </div>

    <div class="summary">
      <span data-testid="eval-count"><span class="mono">{{ runs.length }}</span> line{{ runs.length === 1 ? '' : 's' }}</span>
      <span
        v-if="runs.length > 0"
        class="rate"
        :class="{ good: passRate === 100, bad: passRate != null && passRate < 100 }"
        data-testid="eval-pass-rate"
        :title="
          passRate == null
            ? 'No acceptance line has a verdict yet.'
            : `${decided.length} of ${runs.length} line${runs.length === 1 ? '' : 's'} decided`
        "
      >
        · acceptance
        <span class="mono"><template v-if="passRate != null">{{ passRate }}%</template><template v-else>—</template></span>
      </span>
      <span v-if="meanRating != null" data-testid="eval-mean">· mean rating <span class="mono">{{ meanRating }}/5</span></span>
    </div>

    <div v-if="runs.length === 0" class="ui-empty-line">
      Nothing recorded yet. Write the line first, then the check that fails.
    </div>

    <div v-for="run in runs" :key="run.id" class="ui-card" :data-testid="`eval-row-${run.id}`">
      <div class="ui-card-head">
        <span class="chip-risk" :class="evalStage(run)" :data-testid="`eval-stage-${run.id}`">
          {{ evalStage(run) }}
        </span>
        <span class="acc">{{ run.acceptance }}</span>
        <span class="when mono">{{ shortDate(run.createdAt) }}</span>
        <button class="del" :data-testid="`eval-remove-${run.id}`" title="Remove" @click="evals.remove(projectId, run.id)">
          <Icon name="close" :size="12" />
        </button>
      </div>

      <div class="row-meta">
        <span
          class="ui-chip"
          :class="[run.checkStatus, { 'is-on': run.checkStatus === 'pass', 'is-danger': run.checkStatus === 'fail' }]"
          :data-testid="`eval-check-status-${run.id}`"
        >
          {{ run.checkStatus === 'not_run' ? 'check not run' : `check ${run.checkStatus}` }}
        </span>
        <span v-if="run.attempts > 1" class="ui-chip" :data-testid="`eval-attempts-chip-${run.id}`">
          {{ run.attempts }} attempts
        </span>
        <span v-if="run.checkCmd" class="cmd mono">{{ run.checkCmd }}</span>
        <span v-else class="cmd none">no check — the manual pass is the check</span>
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
          <Icon name="play" :size="12" /> Run check
        </button>
        <button class="act" :data-testid="`eval-manual-${run.id}`" @click="manualPass(run)">
          <Icon name="panel" :size="12" /> Launch &amp; look
        </button>
        <button class="act" :data-testid="`eval-attempts-run-${run.id}`" @click="dispatch(run, 'attempts')">
          <Icon name="fork" :size="12" /> {{ run.attempts === 1 ? 'Implement' : `${run.attempts} attempts` }}
        </button>
        <button class="act" :data-testid="`eval-judge-run-${run.id}`" @click="dispatch(run, 'judge')">
          <Icon name="scales" :size="12" /> Judge
        </button>
        <span class="sep"></span>
        <span class="lbl">attempts</span>
        <div class="ui-segments">
          <button
            v-for="n in 3"
            :key="n"
            class="ui-seg"
            :class="{ on: run.attempts === n, 'is-on': run.attempts === n }"
            :data-testid="`eval-attempts-${run.id}-${n}`"
            :title="n === 1 ? 'One straight run' : `${n} isolated attempts, keep the winner`"
            @click="evals.record(projectId, run.id, { attempts: n })"
          >
            {{ n }}
          </button>
        </div>
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
          <Icon name="star" :size="14" />
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
.rate.good {
  color: var(--green);
}

.rate.bad {
  color: var(--amber);
}

.ui-body {
  max-width: 840px;
}

.intro {
  font-size: var(--fs-ui);
  line-height: 1.6;
  color: var(--text-mid);
  margin-bottom: 16px;
  text-wrap: pretty;
}

.intro .gate {
  display: block;
  margin-top: 6px;
  font-size: var(--fs-meta);
  color: var(--text-faint);
}

.add {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}

.in {
  flex: 1 1 100%;
  min-width: 0;
  padding: 8px 11px;
  font-size: var(--fs-ui);
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
  font-size: var(--fs-meta);
}

.add-btn {
  flex: 0 0 auto;
  padding: 8px 15px;
  font-size: var(--fs-meta);
  font-weight: var(--w-em);
  color: var(--green-ink);
  background: var(--green);
  border-radius: var(--rc);
  cursor: pointer;
}

.add-btn:disabled {
  opacity: 0.45;
  cursor: default;
  box-shadow: none;
}

.ui-err {
  margin-bottom: 8px;
}

.summary {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
  font-size: var(--fs-micro);
  color: var(--text-faint);
}

.ui-card {
  margin-bottom: 9px;
}

.acc {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-ui);
  color: var(--text-bright);
  text-wrap: pretty;
}

.when {
  flex-shrink: 0;
  font-size: var(--fs-micro);
  color: var(--text-faint);
}

.del {
  flex-shrink: 0;
  font-size: var(--fs-meta);
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

.chip-risk {
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-faint);
  border: 1px solid var(--border-strong);
}

.chip-risk.verify {
  color: var(--blue);
  border-color: color-mix(in srgb, var(--blue) 40%, transparent);
}

.chip-risk.review {
  color: var(--amber);
  border-color: color-mix(in srgb, var(--amber) 50%, transparent);
}

.chip-risk.done {
  color: var(--green);
  border-color: color-mix(in srgb, var(--green) 32%, transparent);
}

.judge {
  margin-top: 8px;
  padding: 7px 9px;
  font-size: var(--fs-meta);
  line-height: 1.5;
  color: var(--text-mid);
  background: color-mix(in srgb, var(--amber) 7%, transparent);
  border-left: 1px solid var(--amber);
  border-radius: var(--rc);
  text-wrap: pretty;
}

.gated {
  font-size: var(--fs-micro);
  color: var(--text-faint);
}

.act:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.suites {
  margin-bottom: 14px;
}

.stack {
  margin-bottom: 10px;
}

.ui-kicker {
  margin-bottom: 5px;
}

.ui-row.suite-row {
  gap: 10px;
  padding: 7px 11px;
  margin-bottom: 5px;
  background: var(--bg-card);
  border: 1px solid var(--border-card);
  border-radius: var(--rc);
}

.ui-row.suite-row:hover {
  border-color: var(--green);
}

.suite-kind {
  flex-shrink: 0;
  width: 62px;
  font-size: var(--fs-micro);
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
  font-size: var(--fs-meta);
  color: var(--text-body);
}

.suite-cmd {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-micro);
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cmd {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-micro);
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
  font-size: var(--fs-micro);
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
  font-size: var(--fs-meta);
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
  font-size: var(--fs-micro);
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
  font-size: var(--fs-body);
  line-height: 1;
  color: var(--border-strong);
  cursor: pointer;
}

.star.lit {
  color: var(--amber);
}

.reloop {
  font-size: var(--fs-micro);
  color: var(--amber);
}

.in.note {
  flex: 1 1 100%;
  margin-top: 9px;
  padding: 5px 9px;
  font-size: var(--fs-meta);
}
</style>
