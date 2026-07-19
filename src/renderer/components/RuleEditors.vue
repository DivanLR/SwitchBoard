<script setup lang="ts">
// Rule management (FR-008a, FR-009b, FR-015a) styled to the Switchboard design
// language: standing rules list with revoke, risk rule editor with
// restore-defaults, and the swallow rule editor with global and per-project
// scopes.
import { computed, onMounted, ref } from 'vue'
import type { PermissionRule, RiskClassificationRule, SwallowRule } from '@shared/domain'
import { useProjectsStore } from '@renderer/stores/projects'

const emit = defineEmits<{ (e: 'close'): void }>()
const projects = useProjectsStore()

type Tab = 'standing' | 'risk' | 'swallow'
const tab = ref<Tab>('standing')

// --- Standing rules (per project) ---
const standingProjectId = ref<string>('')
const standingRules = ref<PermissionRule[]>([])

async function loadStanding(): Promise<void> {
  if (!standingProjectId.value) {
    standingRules.value = []
    return
  }
  standingRules.value = await window.switchboard.invoke('rules.standing.list', {
    projectId: standingProjectId.value,
  })
}

async function revoke(ruleId: string): Promise<void> {
  await window.switchboard.invoke('rules.standing.revoke', { ruleId })
  await loadStanding()
}

function matcherLabel(rule: PermissionRule): string {
  switch (rule.matcher.kind) {
    case 'command_prefix':
      return `commands starting with "${rule.matcher.value}"`
    case 'path_glob':
      return `paths matching ${rule.matcher.value}`
    case 'exact_input':
      return 'this exact input'
    case 'tool_only':
      return 'any use of the tool'
  }
}

// --- Risk rules (global) ---
const riskRules = ref<RiskClassificationRule[]>([])

async function loadRisk(): Promise<void> {
  riskRules.value = await window.switchboard.invoke('rules.risk.list', undefined)
}

function addRiskRule(): void {
  riskRules.value.push({
    id: crypto.randomUUID(),
    scope: 'global',
    position: riskRules.value.length,
    toolMatcher: '*',
    inputMatcher: null,
    risk: 'medium',
    builtin: false,
  })
}

function setRiskInputMatcher(rule: RiskClassificationRule, pattern: string): void {
  rule.inputMatcher = pattern
    ? { field: rule.inputMatcher?.field ?? 'command', match: rule.inputMatcher?.match ?? 'regex', pattern }
    : null
}

async function saveRisk(): Promise<void> {
  riskRules.value = await window.switchboard.invoke('rules.risk.save', { rules: riskRules.value })
}

async function restoreRiskDefaults(): Promise<void> {
  riskRules.value = await window.switchboard.invoke('rules.risk.restoreDefaults', undefined)
}

// --- Swallow rules (global + per project) ---
const swallowScope = ref<'global' | string>('global')
const swallowRules = ref<SwallowRule[]>([])

const visibleSwallowRules = computed(() =>
  swallowRules.value.filter((r) =>
    swallowScope.value === 'global' ? r.scope === 'global' : r.projectId === swallowScope.value,
  ),
)

async function loadSwallow(): Promise<void> {
  swallowRules.value = await window.switchboard.invoke('rules.swallow.list', {})
}

function addSwallowRule(): void {
  swallowRules.value.push({
    id: crypto.randomUUID(),
    scope: swallowScope.value === 'global' ? 'global' : 'project',
    projectId: swallowScope.value === 'global' ? null : swallowScope.value,
    position: swallowRules.value.length,
    eventKindMatcher: 'raw_output',
    pattern: '',
    noiseKind: 'noise',
    enabled: true,
  })
}

function removeSwallowRule(id: string): void {
  swallowRules.value = swallowRules.value.filter((r) => r.id !== id)
}

async function saveSwallow(): Promise<void> {
  swallowRules.value = await window.switchboard.invoke('rules.swallow.save', {
    rules: swallowRules.value,
  })
}

async function restoreSwallowDefaults(): Promise<void> {
  swallowRules.value = await window.switchboard.invoke('rules.swallow.restoreDefaults', undefined)
}

onMounted(async () => {
  standingProjectId.value = projects.selectedProjectId ?? projects.items[0]?.id ?? ''
  await Promise.all([loadStanding(), loadRisk(), loadSwallow()])
})
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="dialog rules" data-testid="rule-editors">
      <div class="head">
        <div class="tabs mono">
          <div class="tab" :class="{ on: tab === 'standing' }" data-testid="tab-standing" @click="tab = 'standing'">
            standing rules
          </div>
          <div class="tab" :class="{ on: tab === 'risk' }" data-testid="tab-risk" @click="tab = 'risk'">
            risk rules
          </div>
          <div class="tab" :class="{ on: tab === 'swallow' }" data-testid="tab-swallow" @click="tab = 'swallow'">
            swallow rules
          </div>
        </div>
        <button class="btn-outline" @click="emit('close')">close</button>
      </div>

      <!-- Standing always-allow rules -->
      <section v-if="tab === 'standing'">
        <label class="row">
          <span class="mono lbl">project</span>
          <select v-model="standingProjectId" class="mono" @change="loadStanding()">
            <option v-for="p in projects.items" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
        </label>
        <div v-if="standingRules.length === 0" class="empty mono">
          No standing rules for this project. Create one from a low or medium risk inbox item with
          "always allow".
        </div>
        <div v-for="rule in standingRules" :key="rule.id" class="rule-row" data-testid="standing-rule">
          <div class="rule-meta">
            <div class="mono r-tool">{{ rule.toolName }}</div>
            <div class="mono r-matcher">{{ matcherLabel(rule) }}</div>
          </div>
          <button class="btn-outline" :data-testid="`revoke-${rule.id}`" @click="revoke(rule.id)">
            revoke
          </button>
        </div>
      </section>

      <!-- Risk classification rules -->
      <section v-if="tab === 'risk'">
        <p class="hint mono">
          Ordered, first match wins. Actions not matched by any rule are classified high (fail-safe).
        </p>
        <div v-for="(rule, index) in riskRules" :key="rule.id" class="grid-row" data-testid="risk-rule">
          <span class="mono pos">{{ index + 1 }}</span>
          <input v-model="rule.toolMatcher" class="mono tool" placeholder="tool or *" />
          <input
            :value="rule.inputMatcher?.field ?? ''"
            class="mono field"
            placeholder="field"
            @input="
              rule.inputMatcher = ($event.target as HTMLInputElement).value
                ? {
                    field: ($event.target as HTMLInputElement).value,
                    match: rule.inputMatcher?.match ?? 'regex',
                    pattern: rule.inputMatcher?.pattern ?? '',
                  }
                : null
            "
          />
          <input
            :value="rule.inputMatcher?.pattern ?? ''"
            class="mono pattern"
            placeholder="pattern (regex)"
            @input="setRiskInputMatcher(rule, ($event.target as HTMLInputElement).value)"
          />
          <select v-model="rule.risk" class="mono" :data-testid="`risk-level-${index}`">
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
          </select>
          <button class="x" @click="riskRules.splice(index, 1)">✕</button>
        </div>
        <div class="actions">
          <button class="btn-quiet" data-testid="risk-add" @click="addRiskRule()">add rule</button>
          <button class="btn-quiet" data-testid="risk-restore" @click="restoreRiskDefaults()">
            restore defaults
          </button>
          <button class="btn-solid" data-testid="risk-save" @click="saveRisk()">save</button>
        </div>
      </section>

      <!-- Swallow rules -->
      <section v-if="tab === 'swallow'">
        <label class="row">
          <span class="mono lbl">scope</span>
          <select v-model="swallowScope" class="mono" data-testid="swallow-scope">
            <option value="global">global</option>
            <option v-for="p in projects.items" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
        </label>
        <p class="hint mono">
          Errors, permission requests, plan approvals, questions, prompts, summaries, and results are
          never swallowed, regardless of rules.
        </p>
        <div v-for="rule in visibleSwallowRules" :key="rule.id" class="grid-row" data-testid="swallow-rule">
          <input
            v-model="rule.enabled"
            type="checkbox"
            :data-testid="`swallow-enabled-${rule.noiseKind}`"
            title="Enabled"
          />
          <select v-model="rule.eventKindMatcher" class="mono kind">
            <option value="*">any</option>
            <option value="tool_activity">tool_activity</option>
            <option value="raw_output">raw_output</option>
            <option value="assistant_text">assistant_text</option>
          </select>
          <input v-model="rule.pattern" class="mono pattern" placeholder="pattern (regex)" />
          <input v-model="rule.noiseKind" class="mono label" placeholder="label" />
          <button class="x" @click="removeSwallowRule(rule.id)">✕</button>
        </div>
        <div class="actions">
          <button class="btn-quiet" data-testid="swallow-add" @click="addSwallowRule()">add rule</button>
          <button class="btn-quiet" data-testid="swallow-restore" @click="restoreSwallowDefaults()">
            restore defaults
          </button>
          <button class="btn-solid" data-testid="swallow-save" @click="saveSwallow()">save</button>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.rules {
  width: 760px;
  max-height: 82vh;
  overflow-y: auto;
}

.head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
}

.tabs {
  display: flex;
  gap: 4px;
}

.tab {
  padding: 6px 12px;
  font-size: 12px;
  color: var(--text-tab);
  cursor: pointer;
  border-radius: 6px;
}

.tab:hover {
  color: var(--text-body);
}

.tab.on {
  color: var(--text-strong);
  box-shadow: inset 0 -2px 0 var(--green);
  border-radius: 0;
}

.row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.lbl {
  font-size: 11px;
  color: var(--text-meta);
  width: 60px;
}

.row select {
  font-size: 11.5px;
}

.hint {
  font-size: 10.5px;
  color: var(--text-faint);
  line-height: 1.5;
  margin: 0 0 12px;
}

.empty {
  font-size: 11.5px;
  color: var(--text-faint);
  padding: 14px 0;
  line-height: 1.5;
}

.rule-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 0;
  border-bottom: 1px solid var(--border-hist);
}

.r-tool {
  font-size: 12px;
  color: var(--text-body);
}

.r-matcher {
  font-size: 10.5px;
  color: var(--text-faint);
  margin-top: 2px;
}

.grid-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.grid-row input,
.grid-row select {
  font-size: 11.5px;
  padding: 4px 8px;
}

.pos {
  width: 18px;
  text-align: right;
  font-size: 11px;
  color: var(--text-faint);
}

.tool {
  width: 96px;
}

.field {
  width: 82px;
}

.kind {
  width: 130px;
}

.pattern {
  flex: 1;
  min-width: 0;
}

.label {
  width: 120px;
}

.x {
  color: var(--text-faint);
  font-size: 12px;
  padding: 2px 6px;
}

.x:hover {
  color: var(--red);
}

.actions {
  display: flex;
  gap: 8px;
  margin-top: 14px;
  justify-content: flex-end;
}
</style>
