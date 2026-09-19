<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  SECURITY_SEVERITIES,
  securityScores,
  subagentsAllowed,
  type SecurityRun,
  type SecurityScope,
  type SecuritySeverity,
} from '@shared/domain'
import { useSecurityStore, SECURITY_SKILL_NAME } from '@renderer/stores/security'
import { useSettingsStore } from '@renderer/stores/settings'
import { useSkillsStore } from '@renderer/stores/skills'
import Icon from '@renderer/components/Icon.vue'

const props = defineProps<{ projectId: string }>()
const security = useSecurityStore()
const skills = useSkillsStore()
const settings = useSettingsStore()

const singleAgent = computed(() =>
  settings.settings ? !subagentsAllowed(settings.settings.effort) : false,
)

const scope = ref<SecurityScope>('project')
const selectedId = ref<string | null>(null)

let stopPush: (() => void) | null = null
onMounted(() => {
  void security.load(props.projectId)
  void skills.load()
  stopPush = window.switchboard.on('push.securityChanged', (push) => {
    security.applyPush(push.projectId, push.runs)
  })
})
onUnmounted(() => stopPush?.())

watch(
  () => props.projectId,
  (id) => {
    selectedId.value = null
    void security.load(id)
  },
)

const installed = computed(() =>
  skills.items.some((skill) => skill.name === SECURITY_SKILL_NAME && skill.enabled),
)
const runs = computed(() => security.listFor(props.projectId))
const running = computed(() => security.runningFor(props.projectId))
const selected = computed<SecurityRun | null>(
  () => runs.value.find((run) => run.id === selectedId.value) ?? runs.value[0] ?? null,
)
const scores = computed(() => (selected.value?.report ? securityScores(selected.value.report) : null))

const severityRows = computed(() => {
  const counts = scores.value?.bySeverity
  if (!counts) return []
  const top = Math.max(1, ...SECURITY_SEVERITIES.map((s) => counts[s]))
  return SECURITY_SEVERITIES.map((severity) => ({
    severity,
    count: counts[severity],
    width: `${Math.round((counts[severity] / top) * 100)}%`,
  }))
})

const classRows = computed(() =>
  (scores.value?.byClass ?? []).map((row) => ({
    ...row,
    width: `${Math.round((row.covered / Math.max(1, row.inScope)) * 100)}%`,
  })),
)

const findings = computed(() =>
  (selected.value?.report?.findings ?? [])
    .filter((finding) => finding.verdict !== 'rejected')
    .sort((a, b) => {
      const rank = (s: SecuritySeverity | null): number =>
        s ? SECURITY_SEVERITIES.indexOf(s) : SECURITY_SEVERITIES.length
      return rank(a.severity) - rank(b.severity)
    }),
)

function pctLabel(value: number | null): string {
  return value === null ? '—' : `${value}%`
}

function when(iso: string): string {
  return new Date(iso).toLocaleString()
}

function scopeLabel(value: SecurityScope): string {
  return value === 'project' ? 'whole project' : 'pending changes'
}

async function run(): Promise<void> {
  await security.start(props.projectId, scope.value)
}

async function install(): Promise<void> {
  await security.install()
}
</script>

<template>
  <div class="sec-view" data-testid="security-view">
    <div class="sec-bar">
      <div class="segments mono" role="group" aria-label="Audit scope">
        <button
          type="button"
          class="seg"
          :class="{ on: scope === 'project' }"
          data-testid="security-scope-project"
          :aria-pressed="scope === 'project'"
          @click="scope = 'project'"
        >
          Whole project
        </button>
        <button
          type="button"
          class="seg"
          :class="{ on: scope === 'changes' }"
          data-testid="security-scope-changes"
          :aria-pressed="scope === 'changes'"
          @click="scope = 'changes'"
        >
          Pending changes
        </button>
      </div>
      <button
        v-if="!running"
        type="button"
        class="btn-solid"
        data-testid="security-run"
        :disabled="!installed || security.starting"
        @click="run()"
      >
        {{ security.starting ? 'Starting…' : 'Run audit' }}
      </button>
      <button
        v-else
        type="button"
        class="btn-outline"
        data-testid="security-stop"
        @click="security.cancel(projectId, running.id)"
      >
        Stop
      </button>
      <span v-if="running" class="sec-note mono" data-testid="security-running">
        auditing the {{ scopeLabel(running.scope) }} — the run reports here when it finishes
      </span>
      <span v-else-if="singleAgent" class="sec-note mono" data-testid="security-single-agent">
        subagents are off at this effort, so the audit hunts single-agent and covers less
      </span>
    </div>

    <div v-if="security.error" class="sec-err mono" data-testid="security-error">
      {{ security.error }}
    </div>

    <div v-if="!installed" class="sec-install" data-testid="security-install">
      <div class="si-title">The audit runs on Cloudflare's security-audit skill</div>
      <p class="si-body">
        It maps the trust boundaries, assigns hunters by coverage unit, then has a second agent try
        to disprove every candidate before it counts as confirmed. Switchboard reads the ledger and
        findings it writes, and charts them here.
      </p>
      <button
        type="button"
        class="btn-solid"
        data-testid="security-install-btn"
        :disabled="security.installing"
        @click="install()"
      >
        {{ security.installing ? 'Installing…' : 'Install the skill' }}
      </button>
    </div>

    <div v-else-if="runs.length === 0" class="sec-empty mono faint" data-testid="security-empty">
      No audit has run for this project yet.
    </div>

    <div v-else class="sec-body">
      <div class="sec-runs" data-testid="security-runs">
        <button
          v-for="r in runs"
          :key="r.id"
          type="button"
          class="sec-run"
          :class="{ sel: selected?.id === r.id }"
          :data-testid="`security-run-${r.id}`"
          @click="selectedId = r.id"
        >
          <span class="sr-when mono">{{ when(r.startedAt) }}</span>
          <span class="sr-scope mono">{{ scopeLabel(r.scope) }}</span>
          <span class="sr-status mono" :class="r.status">{{ r.status }}</span>
        </button>
      </div>

      <div class="sec-report">
        <div v-if="selected && selected.status === 'running'" class="sec-empty mono faint">
          This audit is still running.
        </div>
        <div v-else-if="selected && !selected.report" class="sec-empty mono faint" data-testid="security-no-report">
          {{ selected.note ?? 'This run wrote no findings.' }}
        </div>
        <template v-else-if="scores">
          <div class="sec-tiles" data-testid="security-tiles">
            <div class="tile">
              <span class="tile-value" data-testid="security-coverage">{{ pctLabel(scores.coveragePct) }}</span>
              <span class="tile-label mono">coverage units audited</span>
              <span class="tile-sub mono">{{ scores.covered }} of {{ scores.inScope }}</span>
            </div>
            <div class="tile">
              <span class="tile-value" data-testid="security-clean">{{ pctLabel(scores.cleanPct) }}</span>
              <span class="tile-label mono">audited classes with nothing confirmed</span>
            </div>
            <div class="tile">
              <span class="tile-value" data-testid="security-confirmed">{{ scores.confirmed }}</span>
              <span class="tile-label mono">confirmed</span>
              <span class="tile-sub mono">{{ scores.needsValidation }} need validation</span>
            </div>
            <div class="tile">
              <span class="tile-value" data-testid="security-disproved">{{ pctLabel(scores.disprovedPct) }}</span>
              <span class="tile-label mono">candidates disproved</span>
              <span class="tile-sub mono">{{ scores.rejected }} rejected</span>
            </div>
          </div>

          <div class="sec-chart" data-testid="security-severity">
            <div class="sc-title mono">Confirmed by severity</div>
            <div v-for="row in severityRows" :key="row.severity" class="sc-row">
              <span class="sc-key mono">{{ row.severity }}</span>
              <span class="sc-track"><span class="sc-fill" :class="row.severity" :style="{ width: row.width }"></span></span>
              <span class="sc-num mono">{{ row.count }}</span>
            </div>
          </div>

          <div class="sec-chart" data-testid="security-classes">
            <div class="sc-title mono">Coverage by attack class</div>
            <div v-if="classRows.length === 0" class="sc-none mono faint">
              This run recorded no coverage units.
            </div>
            <div v-for="row in classRows" :key="row.attackClass" class="sc-row">
              <span class="sc-key mono" :title="row.attackClass">{{ row.attackClass }}</span>
              <span class="sc-track"><span class="sc-fill covered" :style="{ width: row.width }"></span></span>
              <span class="sc-num mono">{{ row.covered }}/{{ row.inScope }}</span>
              <span v-if="row.confirmed > 0" class="chip-risk high">{{ row.confirmed }}</span>
            </div>
          </div>

          <div class="sec-findings" data-testid="security-findings">
            <div class="sc-title mono">Findings</div>
            <div v-if="findings.length === 0" class="sc-none mono faint">
              Nothing confirmed, and nothing left open.
            </div>
            <div
              v-for="finding in findings"
              :key="finding.fingerprint"
              class="sf-row"
              :data-testid="`security-finding-${finding.fingerprint}`"
            >
              <span class="chip-risk" :class="finding.verdict === 'confirmed' ? 'high' : 'medium'">
                {{ finding.verdict === 'confirmed' ? (finding.severity ?? 'confirmed') : 'needs validation' }}
              </span>
              <span class="sf-title">{{ finding.title }}</span>
              <span v-if="finding.file" class="sf-where mono">
                {{ finding.file }}{{ finding.line ? `:${finding.line}` : '' }}
              </span>
            </div>
          </div>

          <div v-if="selected" class="sec-artefacts" data-testid="security-artefacts">
            <button
              v-for="file in selected.report?.artefacts ?? []"
              :key="file"
              type="button"
              class="btn-quiet mono"
              :data-testid="`security-artefact-${file}`"
              @click="security.openReport(projectId, selected.id, file)"
            >
              <Icon name="file" :size="12" />
              {{ file }}
            </button>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sec-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 18px 24px;
  gap: 14px;
}

.sec-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.segments {
  display: flex;
  border: 1px solid var(--border-seg);
  border-radius: var(--rc);
  overflow: hidden;
}

.seg {
  padding: 4px 12px;
  font-size: var(--fs-meta);
  color: var(--text-tab);
  background: transparent;
  border: none;
  cursor: pointer;
}

.seg.on {
  color: var(--text-bright);
  background: var(--bg-seg);
}

.sec-note,
.sec-err {
  font-size: var(--fs-meta);
  color: var(--text-meta);
}

.sec-err {
  color: var(--red);
}

.sec-install {
  border: 1px solid var(--border-card);
  border-radius: var(--rc-card);
  background: var(--bg-card);
  padding: 16px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  max-width: 640px;
}

.si-title {
  font-size: var(--fs-ui);
  color: var(--text-strong);
}

.si-body {
  font-size: var(--fs-meta);
  color: var(--text-mid);
  line-height: 1.55;
}

.sec-empty {
  padding: 30px 0;
  font-size: var(--fs-ui);
}

.sec-body {
  display: flex;
  gap: 18px;
  min-height: 0;
}

.sec-runs {
  width: 240px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.sec-run {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 7px 9px;
  border: 1px solid transparent;
  border-radius: var(--rc);
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.sec-run:hover {
  background: var(--bg-hover);
}

.sec-run.sel {
  border-color: var(--border-card);
  background: var(--bg-card);
}

.sr-when {
  font-size: var(--fs-meta);
  color: var(--text);
}

.sr-scope,
.sr-status {
  font-size: var(--fs-micro);
  color: var(--text-meta);
}

.sr-status.complete {
  color: var(--green);
}

.sr-status.failed {
  color: var(--red);
}

.sr-status.running {
  color: var(--amber);
}

.sec-report {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.sec-tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: 10px;
}

.tile {
  border: 1px solid var(--border-card);
  border-radius: var(--rc-card);
  background: var(--bg-card);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.tile-value {
  font-size: var(--fs-title);
  color: var(--text-bright);
}

.tile-label,
.tile-sub {
  font-size: var(--fs-micro);
  color: var(--text-meta);
}

.sec-chart,
.sec-findings {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.sc-title {
  font-size: var(--fs-micro);
  color: var(--text-label);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.sc-none {
  font-size: var(--fs-meta);
}

.sc-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.sc-key {
  width: 190px;
  flex-shrink: 0;
  font-size: var(--fs-meta);
  color: var(--text-mid);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sc-track {
  flex: 1;
  height: 8px;
  border-radius: var(--rc);
  background: var(--bg-seg);
  overflow: hidden;
}

.sc-fill {
  display: block;
  height: 100%;
  background: var(--text-meta);
}

.sc-fill.covered {
  background: var(--green);
}

.sc-fill.critical,
.sc-fill.high {
  background: var(--red);
}

.sc-fill.medium {
  background: var(--amber);
}

.sc-fill.low,
.sc-fill.informational {
  background: var(--teal);
}

.sc-num {
  width: 60px;
  text-align: right;
  font-size: var(--fs-micro);
  color: var(--text-meta);
}

.sf-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 6px 0;
  border-bottom: 1px solid var(--border-soft);
}

.sf-title {
  flex: 1;
  font-size: var(--fs-meta);
  color: var(--text);
}

.sf-where {
  font-size: var(--fs-micro);
  color: var(--text-meta);
}

.sec-artefacts {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
