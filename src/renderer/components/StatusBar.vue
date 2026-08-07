<script setup lang="ts">
// The window's instrument line: the readings that describe the whole board
// rather than any one session, on one rule pinned under every pane.
//
// These figures used to sit in the sidebar footer, stacked as a card above the
// Settings row, which cost the lane list a sixth of its height and put
// board-wide readings inside a pane that is about one project at a time. A
// control room puts its gauges along the bottom edge, where they are always
// legible and never in the way of the work.
//
// Every figure is reported, never estimated, and the test ids move with the
// markup: the readings are the same truth, in a better place.
import { computed } from 'vue'
import { useProjectsStore } from '@renderer/stores/projects'

const projects = useProjectsStore()

const costLabel = computed(() => `$${projects.counters.costTodayUsd.toFixed(2)}`)

const tokensLabel = computed(() =>
  // Compact notation; lowercase the 'K' suffix to keep the design's "1.2k" style.
  Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
    .format(projects.counters.tokensToday)
    .replace('K', 'k'),
)

/** Ctrl+C only does anything mid-turn, so the hint only claims it mid-turn. */
const anyWorking = computed(() =>
  projects.items.some((p) => p.session && !p.session.endedAt && p.session.status === 'working'),
)
</script>

<template>
  <div class="statusbar mono" data-testid="statusbar">
    <span class="sb-stat" data-testid="counter-running">
      <span class="sb-dot" style="background: var(--blue)"></span>
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

    <!-- Exactly "<n> tok": the token total is asserted as whole text, and the
         figure carries its unit rather than a separate label. -->
    <span class="sb-stat" data-testid="usage-tokens">
      <span class="sb-val">{{ tokensLabel }}</span> tok
    </span>

    <span class="sb-gap"></span>

    <!-- Only bindings that exist. There is no command palette to advertise. -->
    <span v-if="anyWorking" class="sb-hint">
      <kbd>⌃C</kbd>
      interrupt
    </span>
    <span class="sb-hint">
      <kbd>⏎</kbd>
      send
    </span>
  </div>
</template>

<style scoped>
/* One rule, one line of readings. The bar is a hairline band, not a panel: it
   borrows the sticky ground so it reads as part of the window frame rather than
   as another card. */
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

/* Names of readings, not sentences: uppercase and tracked, in the label voice
   this world declared in --track-label and had never adopted. */
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
  width: 5px;
  height: 5px;
  border-radius: 50%;
}

/* A separator, not a divider: the same hairline the panes use, one glyph high. */
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
