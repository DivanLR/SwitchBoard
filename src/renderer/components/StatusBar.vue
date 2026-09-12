<script setup lang="ts">
import { computed } from 'vue'
import Icon from '@renderer/components/Icon.vue'
import { useProjectsStore } from '@renderer/stores/projects'

const projects = useProjectsStore()

const costLabel = computed(() => `$${projects.counters.costTodayUsd.toFixed(2)}`)

const tokensLabel = computed(() =>
  Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
    .format(projects.counters.tokensToday)
    .replace('K', 'k'),
)

const anyWorking = computed(() =>
  projects.items.some((p) => p.session && !p.session.endedAt && p.session.status === 'working'),
)
</script>

<template>
  <div class="statusbar mono" data-testid="statusbar">
    <span class="sb-stat" data-testid="counter-running">
      <span class="sb-dot" style="background: var(--running)"></span>
      <span class="sb-label">run</span>
      <span class="sb-val" data-testid="counter-running-value">{{ projects.counters.running }}</span>
    </span>

    <span class="sb-stat" data-testid="counter-needsyou">
      <span class="sb-dot" style="background: var(--amber)"></span>
      <span class="sb-label">wait</span>
      <span class="sb-val amber" data-testid="counter-needsyou-value">
        {{ projects.counters.needsYou }}
      </span>
    </span>

    <span class="sb-rule"></span>

    <span class="sb-stat" data-testid="counter-cost">
      <span class="sb-label">today</span>
      <span class="sb-val" data-testid="counter-cost-value">{{ costLabel }}</span>
    </span>

    <span class="sb-stat" data-testid="usage-tokens">
      <span class="sb-val">{{ tokensLabel }}</span> tok
    </span>

    <span class="sb-gap"></span>

    <span v-if="anyWorking" class="sb-hint">
      <kbd>⌃C</kbd>
      interrupt
    </span>
    <span class="sb-hint">
      <kbd><Icon name="send" :size="10" /></kbd>
      send
    </span>
  </div>
</template>

<style scoped>
.statusbar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 14px;
  height: 25px;
  padding: 0 14px 0 18px;
  border-top: 1px solid var(--border);
  background: var(--bg-sticky);
  font-size: var(--fs-micro);
  color: var(--text-faint);
  white-space: nowrap;
}

.sb-stat {
  display: flex;
  align-items: center;
  gap: 6px;
}

.sb-label {
  text-transform: uppercase;
  letter-spacing: var(--track-label);
  color: var(--text-ghost);
}

.sb-val {
  color: var(--text-strong);
}

.sb-val.amber {
  color: var(--amber);
}

.sb-dot {
  width: 6px;
  height: 6px;
  border-radius: var(--sq);
}

.sb-rule {
  width: 1px;
  height: 11px;
  background: var(--border);
}

.sb-gap {
  flex: 1;
}

.sb-hint {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--text-ghost);
}

.sb-hint kbd {
  font-family: var(--mono);
  font-size: var(--fs-micro);
  line-height: 1;
  padding: 2px 4px;
  color: var(--text-meta);
  border: 1px solid var(--border-soft);
}
</style>
