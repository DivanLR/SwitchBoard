<script setup lang="ts">
// THE ICON SET.
//
// Every mark in this app used to be a Unicode character printed as text: ✓ → ✕
// ▶ ✎ ● ⚠ ✦ ⚙ ⛁ ⎇ 🗑 and fifty more. Measured against the font actually
// shipped, 58 of those 61 glyphs ARE NOT IN IT — src/renderer/assets/fonts
// carries a 663-codepoint Latin subset of JetBrains Mono and nothing else. So
// every icon fell back to whatever Windows offered: Segoe UI Symbol for most,
// Segoe UI Emoji for 🗑 and 🔊, which render in fixed colour and ignore the
// colour they are given.
//
// That is why the chrome never looked like one thing. A fallback glyph does not
// share the surrounding text's stroke weight, does not sit on its baseline, does
// not follow the variable weight axis (--w-em), and two marks from two Unicode
// blocks can land in two different fallback faces side by side.
//
// These are drawn instead. One 16-unit grid, one 1.5 stroke, round caps and
// joins, currentColor throughout — so a mark inherits its colour from the thing
// it sits in, scales with the type ramp, and is identical on every machine.
//
// Adding one: give it a semantic name (what it MEANS, never what it looks like),
// draw it on the same grid, and keep the stroke at 1.5 unless it is a solid.
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    name: string
    /** Edge length in px. Defaults to the body text size so a mark sits in a line. */
    size?: number | string
  }>(),
  { size: 14 },
)

interface Mark {
  d: string
  /** Solid marks (a status dot, a run triangle) carry no stroke. */
  solid?: boolean
}

// Ordered by what they mean, not alphabetically: outcomes, movement, actions,
// objects, state.
const MARKS: Record<string, Mark> = {
  // Outcomes
  check: { d: 'M3 8.5 6.5 12 13 4' },
  // One X for every negation. The app had two — U+2715 for "remove/close" and
  // U+2717 for "failed" — sitting rows apart in the same list at different
  // optical weights. The names stay separate so a call site still reads as what
  // it means; the mark is deliberately identical.
  close: { d: 'M4 4 12 12M12 4 4 12' },
  cross: { d: 'M4 4 12 12M12 4 4 12' },
  warning: { d: 'M8 2.6 14.2 13H1.8ZM8 6.6V9.6M8 11.4v.1' },
  spark: { d: 'M8 1.8 9.4 6.6 14.2 8 9.4 9.4 8 14.2 6.6 9.4 1.8 8 6.6 6.6Z' },
  star: { d: 'M8 1.9 9.9 6.1 14.4 6.6 11 9.7 11.9 14.1 8 11.9 4.1 14.1 5 9.7 1.6 6.6 6.1 6.1Z' },

  // Movement
  'arrow-right': { d: 'M2.8 8h10.4M9.2 4 13.2 8 9.2 12' },
  'arrow-left': { d: 'M13.2 8H2.8M6.8 4 2.8 8l4 4' },
  'arrow-up': { d: 'M8 13.2V2.8M4 6.8 8 2.8l4 4' },
  'arrow-down': { d: 'M8 2.8v10.4M4 9.2 8 13.2l4-4' },
  'chevron-right': { d: 'M6 3.2 10.8 8 6 12.8' },
  'chevron-left': { d: 'M10 3.2 5.2 8 10 12.8' },
  'chevron-down': { d: 'M3.2 6 8 10.8 12.8 6' },
  'chevron-up': { d: 'M3.2 10 8 5.2 12.8 10' },
  external: { d: 'M7 3.5H3.2v9.3h9.3V9M9.4 3.5h3.1v3.1M12.5 3.5 7.6 8.4' },
  swap: { d: 'M2.8 5.4h9.6M9.6 2.6 12.4 5.4 9.6 8.2M13.2 10.6H3.6M6.4 7.8 3.6 10.6 6.4 13.4' },
  download: { d: 'M8 2.4v8.2M4.6 7.4 8 10.8l3.4-3.4M2.8 13.4h10.4' },
  refresh: { d: 'M12.8 8a4.8 4.8 0 1 1-1.5-3.5M13 2.6v2.6h-2.6' },

  // Actions
  play: { d: 'M5.2 3.4 12.6 8 5.2 12.6Z', solid: true },
  stop: { d: 'M4.6 4.6h6.8v6.8H4.6Z', solid: true },
  pencil: { d: 'M10.9 2.5 13.5 5.1 5.9 12.7 2.6 13.4 3.3 10.1Z' },
  // Saying something about a specific line, not editing it: the diff pane's
  // per-line affordance. A bubble rather than the pencil beside it, because the
  // pencil means "change this text" and this means "ask for a change here".
  comment: {
    d: 'M5 3.2H11A2.2 2.2 0 0 1 13.2 5.4V8.6A2.2 2.2 0 0 1 11 10.8H7.2L5.2 13.2V10.8H5A2.2 2.2 0 0 1 2.8 8.6V5.4A2.2 2.2 0 0 1 5 3.2Z',
  },
  plus: { d: 'M8 3.4v9.2M3.4 8h9.2' },
  minus: { d: 'M3.4 8h9.2' },
  trash: { d: 'M2.8 4.4h10.4M6.2 4.4V2.8h3.6v1.6M4.4 4.4l.7 8.8h5.8l.7-8.8' },
  search: { d: 'M7.2 11.4a4.2 4.2 0 1 0 0-8.4 4.2 4.2 0 0 0 0 8.4ZM10.4 10.4l3 3' },
  send: { d: 'M13.2 3.2v5.4H3.6M6.6 5.6 3.6 8.6l3 3' },
  settings: {
    d: 'M8 10.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4ZM8 1.6v1.8M8 12.6v1.8M14.4 8h-1.8M3.4 8H1.6M12.5 3.5 11.3 4.7M4.7 11.3 3.5 12.5M12.5 12.5 11.3 11.3M4.7 4.7 3.5 3.5',
  },

  // Objects
  database: {
    d: 'M13 4.2c0 1.2-2.2 2.2-5 2.2S3 5.4 3 4.2 5.2 2 8 2s5 1 5 2.2ZM3 4.2v7.6c0 1.2 2.2 2.2 5 2.2s5-1 5-2.2V4.2M13 8c0 1.2-2.2 2.2-5 2.2S3 9.2 3 8',
  },
  branch: {
    d: 'M4.6 5.2a1.7 1.7 0 1 0 0-3.4 1.7 1.7 0 0 0 0 3.4ZM4.6 14.2a1.7 1.7 0 1 0 0-3.4 1.7 1.7 0 0 0 0 3.4ZM11.4 5.2a1.7 1.7 0 1 0 0-3.4 1.7 1.7 0 0 0 0 3.4ZM4.6 5.2v5.6M11.4 5.2c0 3-6.8 1.6-6.8 5.6',
  },
  folder: { d: 'M2.4 12.6V4a.8.8 0 0 1 .8-.8h3.1l1.5 1.8h5a.8.8 0 0 1 .8.8v6.8a.8.8 0 0 1-.8.8H3.2a.8.8 0 0 1-.8-.8Z' },
  file: { d: 'M9 1.9H4.4a.9.9 0 0 0-.9.9v10.4a.9.9 0 0 0 .9.9h7.2a.9.9 0 0 0 .9-.9V5.3ZM9 1.9v3.4h3.5' },
  terminal: { d: 'M3.4 4.2 6.6 7.6 3.4 11M8.2 11.6h4.4' },
  layers: { d: 'M8 1.9 14.1 5.4 8 8.9 1.9 5.4ZM1.9 10.1 8 13.6l6.1-3.5' },
  scales: { d: 'M8 2.6v10.8M4.6 13.4h6.8M2.4 5.6 8 4.2l5.6 1.4M2.4 5.6.9 9.4a2.6 2.6 0 0 0 3 0ZM13.6 5.6l-1.5 3.8a2.6 2.6 0 0 0 3 0Z' },
  fork: {
    d: 'M4.4 4.8a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2ZM11.6 4.8a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2ZM8 14.4a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2ZM4.4 4.8v1.6c0 1.4 3.6 1.4 3.6 2.8M11.6 4.8v1.6c0 1.4-3.6 1.4-3.6 2.8',
  },
  clock: { d: 'M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12ZM8 4.8V8l2.2 1.4' },
  panel: { d: 'M2.4 2.6h11.2v10.8H2.4ZM2.4 8.6h5v4.8' },
  grid: { d: 'M2.6 2.6h4.6v4.6H2.6ZM8.8 2.6h4.6v4.6H8.8ZM2.6 8.8h4.6v4.6H2.6ZM8.8 8.8h4.6v4.6H8.8Z' },
  moon: { d: 'M13 9.7A5.7 5.7 0 0 1 6.3 3a5.7 5.7 0 1 0 6.7 6.7Z' },
  sun: {
    d: 'M8 11.1a3.1 3.1 0 1 0 0-6.2 3.1 3.1 0 0 0 0 6.2ZM8 1.4v1.5M8 13.1v1.5M14.6 8h-1.5M2.9 8H1.4M12.7 3.3l-1.1 1.1M4.4 11.6l-1.1 1.1M12.7 12.7l-1.1-1.1M4.4 4.4 3.3 3.3',
  },

  // State
  dot: { d: 'M8 11.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z', solid: true },
  circle: { d: 'M8 12.2a4.2 4.2 0 1 0 0-8.4 4.2 4.2 0 0 0 0 8.4Z' },
  diamond: { d: 'M8 2 14 8 8 14 2 8Z' },
  square: { d: 'M3 3h10v10H3Z' },
  'square-check': { d: 'M3 3h10v10H3ZM5.4 8 7.4 10 10.6 6' },
}

const mark = computed((): Mark => MARKS[props.name] ?? MARKS.circle)
const px = computed(() => (typeof props.size === 'number' ? `${props.size}px` : props.size))
</script>

<template>
  <svg
    class="icon"
    :style="{ width: px, height: px }"
    viewBox="0 0 16 16"
    :fill="mark.solid ? 'currentColor' : 'none'"
    :stroke="mark.solid ? 'none' : 'currentColor'"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path :d="mark.d" />
  </svg>
</template>

<style scoped>
/* Sits on the text baseline rather than the line box, so a mark beside a word
   is centred on the word instead of riding high — the exact defect the fallback
   glyphs had, and the reason several call sites carried hand-tuned margins. */
.icon {
  display: inline-block;
  vertical-align: -0.15em;
  flex-shrink: 0;
}
</style>
