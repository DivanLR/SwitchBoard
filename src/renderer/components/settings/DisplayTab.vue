<script setup lang="ts">
import type { Settings } from '@shared/domain'
import { useSettingsStore } from '@renderer/stores/settings'

defineProps<{ settings: Settings }>()

const store = useSettingsStore()

function save(patch: Partial<Settings>): void {
  void store.save(patch)
}

const FONT_SIZES = [
  ['sm', 'Small'],
  ['md', 'Medium'],
  ['lg', 'Large'],
] as const satisfies readonly (readonly [Settings['fontSize'], string])[]
</script>

<template>
  <div class="ui-kicker group-label">OUTPUT</div>
  <div class="group-desc">How each session's output looks and behaves.</div>

  <div class="ui-card setting-row is-actionable">
    <div class="sr-text">
      <div class="sr-label">Font size</div>
      <div class="sr-desc">Text size in the Clean and Raw views</div>
    </div>
    <div class="ui-segments">
      <button
        v-for="[v, label] in FONT_SIZES"
        :key="v"
        class="ui-seg"
        :class="{ on: settings.fontSize === v, 'is-on': settings.fontSize === v }"
        :data-testid="`setting-font-${v}`"
        @click="save({ fontSize: v })"
      >
        {{ label }}
      </button>
    </div>
  </div>

  <div class="ui-card setting-row is-actionable">
    <div class="sr-text">
      <div class="sr-label">Default view</div>
      <div class="sr-desc">What a session opens in — Clean summaries or the raw terminal</div>
    </div>
    <div class="ui-segments">
      <button
        class="ui-seg"
        :class="{ on: settings.defaultView === 'clean', 'is-on': settings.defaultView === 'clean' }"
        data-testid="setting-view-clean"
        @click="save({ defaultView: 'clean' })"
      >
        Clean
      </button>
      <button
        class="ui-seg"
        :class="{ on: settings.defaultView === 'raw', 'is-on': settings.defaultView === 'raw' }"
        data-testid="setting-view-raw"
        @click="save({ defaultView: 'raw' })"
      >
        Raw
      </button>
    </div>
  </div>

  <div class="ui-card setting-row is-actionable">
    <div class="sr-text">
      <div class="sr-label">Show tool activity in Clean view</div>
      <div class="sr-desc">
        Off: Clean view hides commands and tool calls entirely. On: they collapse into
        expandable "worked quietly" rows. Raw view always shows everything.
      </div>
    </div>
    <button
      class="switch"
      :class="{ on: settings.showToolRows }"
      data-testid="setting-tool-rows"
      role="switch"
      :aria-checked="settings.showToolRows"
      @click="save({ showToolRows: !settings.showToolRows })"
    >
      <span class="knob"></span>
    </button>
  </div>

  <div class="ui-card setting-row is-actionable">
    <div class="sr-text">
      <div class="sr-label">Show injected context in Clean view</div>
      <div class="sr-desc">
        System reminders, expanded slash commands and hook output — everything added to
        your message before the model read it. Off: Clean view hides them. Raw view always
        shows them in full.
      </div>
    </div>
    <button
      class="switch"
      :class="{ on: settings.showInjections }"
      data-testid="setting-injections"
      role="switch"
      :aria-checked="settings.showInjections"
      @click="save({ showInjections: !settings.showInjections })"
    >
      <span class="knob"></span>
    </button>
  </div>

  <div class="ui-card setting-row is-actionable">
    <div class="sr-text">
      <div class="sr-label">Session timer</div>
      <div class="sr-desc">
        Show how long each session has been open, in the sidebar and the header
      </div>
    </div>
    <button
      class="switch"
      :class="{ on: settings.showSessionTimer }"
      data-testid="setting-session-timer"
      role="switch"
      :aria-checked="settings.showSessionTimer"
      @click="save({ showSessionTimer: !settings.showSessionTimer })"
    >
      <span class="knob"></span>
    </button>
  </div>

  <div class="ui-card setting-row is-actionable">
    <div class="sr-text">
      <div class="sr-label">Timestamps</div>
      <div class="sr-desc">Show the time next to every event in the Clean view</div>
    </div>
    <button
      class="switch"
      :class="{ on: settings.timestamps }"
      data-testid="setting-timestamps"
      role="switch"
      :aria-checked="settings.timestamps"
      @click="save({ timestamps: !settings.timestamps })"
    >
      <span class="knob"></span>
    </button>
  </div>

  <div class="ui-card setting-row is-actionable">
    <div class="sr-text">
      <div class="sr-label">Follow output</div>
      <div class="sr-desc">Keep the view pinned to the newest line while Claude works</div>
    </div>
    <button
      class="switch"
      :class="{ on: settings.autoscroll }"
      data-testid="setting-autoscroll"
      role="switch"
      :aria-checked="settings.autoscroll"
      @click="save({ autoscroll: !settings.autoscroll })"
    >
      <span class="knob"></span>
    </button>
  </div>
</template>
