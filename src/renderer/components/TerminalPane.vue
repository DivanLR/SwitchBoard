<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { SessionEngine } from '@shared/domain'
import { useTerminalStore } from '@renderer/stores/terminal'

const props = defineProps<{
  id: string
  cwd: string
  engine: SessionEngine | 'shell'
}>()

const terminals = useTerminalStore()
const host = ref<HTMLDivElement | null>(null)
const term = shallowRef<Terminal | null>(null)
const fit = shallowRef<FitAddon | null>(null)
const exited = ref<number | null>(null)
const unsubscribes: (() => void)[] = []
let resizeObserver: ResizeObserver | null = null
let attachToken = 0

function themeColors(): Record<string, string> {
  const style = getComputedStyle(document.documentElement)
  const value = (name: string, fallback: string): string =>
    style.getPropertyValue(name).trim() || fallback
  return {
    background: value('--bg-code', '#0b0d0c'),
    foreground: value('--text-body', '#d5d8d4'),
    cursor: value('--green', '#7ee081'),
    selectionBackground: value('--bg-hover', '#1d201e'),
  }
}

async function pushSize(): Promise<void> {
  const instance = term.value
  if (!instance || !fit.value) return
  if (!host.value?.clientWidth || !host.value.clientHeight) return
  fit.value.fit()
  await terminals.resize(props.id, instance.cols, instance.rows)
}

async function attach(): Promise<void> {
  const instance = term.value
  if (!instance) return
  const token = ++attachToken
  const id = props.id
  exited.value = null
  const { scrollback } = await terminals.open({
    id,
    cwd: props.cwd,
    cols: instance.cols,
    rows: instance.rows,
    engine: props.engine,
  })
  if (token !== attachToken || term.value !== instance) return
  if (scrollback) instance.write(scrollback)
  unsubscribes.push(terminals.onData(id, (data) => instance.write(data)))
  unsubscribes.push(
    terminals.onExit(id, (exitCode) => {
      exited.value = exitCode
    }),
  )
}

onMounted(async () => {
  const instance = new Terminal({
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono').trim(),
    fontSize: 12,
    convertEol: false,
    cursorBlink: true,
    scrollback: 10_000,
    theme: themeColors(),
  })
  const fitAddon = new FitAddon()
  instance.loadAddon(fitAddon)
  term.value = instance
  fit.value = fitAddon
  if (host.value) instance.open(host.value)
  fitAddon.fit()
  instance.onData((data) => void terminals.write(props.id, data))
  resizeObserver = new ResizeObserver(() => void pushSize())
  if (host.value) resizeObserver.observe(host.value)
  await attach()
  instance.focus()
})

watch(
  () => props.id,
  async () => {
    for (const stop of unsubscribes.splice(0)) stop()
    term.value?.reset()
    await attach()
  },
)

onBeforeUnmount(() => {
  attachToken += 1
  for (const stop of unsubscribes.splice(0)) stop()
  resizeObserver?.disconnect()
  resizeObserver = null
  term.value?.dispose()
  term.value = null
})

async function restart(): Promise<void> {
  await terminals.close(props.id)
  term.value?.reset()
  await attach()
  term.value?.focus()
}
</script>

<template>
  <div class="terminal-pane" data-testid="terminal-pane">
    <div ref="host" class="terminal-host"></div>
    <div v-if="exited !== null" class="terminal-exit mono" data-testid="terminal-exited">
      Shell exited ({{ exited }}).
      <button type="button" class="btn-quiet" data-testid="terminal-restart" @click="restart()">
        Start a new one
      </button>
    </div>
  </div>
</template>

<style scoped>
.terminal-pane {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-code);
  padding: 8px 10px;
}

.terminal-host {
  flex: 1;
  min-height: 0;
}

.terminal-exit {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 2px 0;
  font-size: var(--fs-meta);
  color: var(--text-ghost);
}
</style>
