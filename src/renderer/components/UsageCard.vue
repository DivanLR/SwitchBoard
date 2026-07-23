<script setup lang="ts">
// Structured /usage view: limit meters up top, then each activity window as a
// dotted list (behaviours + Top skills/subagents/plugins/MCP servers).
import type { UsageReport } from '@shared/usage-report'

defineProps<{ report: UsageReport }>()

function barColor(pct: number): string {
  return pct > 85 ? 'var(--red)' : pct > 60 ? 'var(--amber)' : 'var(--green)'
}
</script>

<template>
  <div class="usage-card" data-testid="usage-card">
    <div class="uc-label mono">✦ USAGE</div>

    <!-- Limit meters -->
    <div v-for="l in report.limits" :key="l.label" class="uc-meter" data-testid="usage-meter">
      <span class="uc-meter-label mono">{{ l.label }}</span>
      <span class="uc-meter-pct mono" :style="{ color: barColor(l.pct) }">{{ l.pct }}%</span>
      <div class="uc-bar">
        <div class="uc-fill" :style="{ width: `${l.pct}%`, background: barColor(l.pct) }"></div>
      </div>
      <span class="uc-meter-resets mono">resets {{ l.resets }}</span>
    </div>

    <div v-if="report.notes.length" class="uc-notes">{{ report.notes.join(' ') }}</div>

    <!-- Activity windows as dotted lists -->
    <div v-for="w in report.windows" :key="w.title" class="uc-window" data-testid="usage-window">
      <div class="uc-win-head mono">
        <span class="uc-win-title">{{ w.title.toUpperCase() }}</span>
        <span class="uc-win-volume">{{ w.volume }}</span>
      </div>
      <ul class="uc-list">
        <li v-for="b in w.behaviors" :key="b">{{ b }}</li>
        <li v-for="t in w.tops" :key="t.label">
          <span class="uc-top-label">{{ t.label }}:</span>
          <span v-for="(item, i) in t.items" :key="item" class="uc-top-item mono">
            {{ item }}<span v-if="i < t.items.length - 1" class="uc-sep"> · </span>
          </span>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.usage-card {
  border: 1px solid var(--border-card-alt);
  background: var(--gloss), var(--bg-card);
  border-radius: var(--rc);
  padding: 12px 14px;
  margin-bottom: 13px;
}

.uc-label {
  font-size: 10px;
  letter-spacing: 0.13em;
  color: var(--green);
  margin-bottom: 9px;
}

/* Meter rows: label · % · bar · reset time. */
.uc-meter {
  display: grid;
  grid-template-columns: 175px 38px 1fr auto;
  align-items: center;
  gap: 10px;
  margin-bottom: 7px;
}

.uc-meter-label {
  font-size: 11px;
  color: var(--text-body);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.uc-meter-pct {
  font-size: 11px;
  font-weight: 600;
  text-align: right;
}

.uc-bar {
  height: 4px;
  border-radius: 99px;
  background: rgba(255, 255, 255, 0.07);
  overflow: hidden;
}

.uc-fill {
  height: 100%;
  border-radius: 99px;
}

.uc-meter-resets {
  font-size: 10px;
  color: var(--text-faint);
  white-space: nowrap;
}

.uc-notes {
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--text-faint);
  margin: 9px 0 2px;
  text-wrap: pretty;
}

.uc-window {
  margin-top: 11px;
}

.uc-win-head {
  display: flex;
  align-items: baseline;
  gap: 9px;
  margin-bottom: 5px;
}

.uc-win-title {
  font-size: 10px;
  letter-spacing: 0.13em;
  color: var(--teal);
}

.uc-win-volume {
  font-size: 10.5px;
  color: var(--text-meta);
}

/* The dotted list. */
.uc-list {
  margin: 0;
  padding-left: 18px;
}

.uc-list li {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-body);
  margin: 2px 0;
}

.uc-list li::marker {
  color: var(--green);
}

.uc-top-label {
  color: var(--text-meta);
  margin-right: 6px;
}

.uc-top-item {
  font-size: 11px;
  color: var(--text-body);
  white-space: nowrap;
}

.uc-sep {
  color: var(--text-faint);
}
</style>
