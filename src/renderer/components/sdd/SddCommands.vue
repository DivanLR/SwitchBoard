<script setup lang="ts">
import type { SddCommand } from '@shared/sdd'
import Icon from '@renderer/components/Icon.vue'

const props = defineProps<{
  commands: readonly SddCommand[]
  target: string | null
  busy: readonly string[]
}>()
const emit = defineEmits<{ (e: 'run', command: SddCommand): void }>()

function blocked(command: SddCommand): boolean {
  return props.busy.includes(command.command) || ((command.needs === 'spec' || command.needs === 'slug') && !props.target)
}
</script>

<template>
  <div class="sdd-cmds" data-testid="sdd-commands">
    <button
      v-for="c in commands"
      :key="c.command"
      type="button"
      class="ui-card is-actionable sdd-cmd"
      :disabled="blocked(c)"
      :data-testid="`sdd-cmd-${c.command}`"
      @click="emit('run', c)"
    >
      <span class="sdd-cmd-row">
        <span class="mono sdd-cmd-name">{{ c.label }}</span>
        <span class="spacer"></span>
        <span class="sdd-cmd-run">
          <Icon :name="busy.includes(c.command) ? 'dot' : 'play'" :size="11" />
          {{ busy.includes(c.command) ? 'Running' : 'Run' }}
        </span>
      </span>
      <span class="sdd-cmd-hint">{{ c.hint }}</span>
    </button>
  </div>
</template>

<style scoped>
.sdd-cmds {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: var(--sp-3);
}

.sdd-cmd {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: var(--sp-2);
  text-align: left;
  cursor: pointer;
}

.sdd-cmd-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.sdd-cmd-name {
  font-size: var(--fs-ui);
  color: var(--text-strong);
}

.sdd-cmd-run {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  font-size: var(--fs-meta);
  color: var(--green);
}

.sdd-cmd-hint {
  font-size: var(--fs-meta);
  line-height: 1.4;
  color: var(--text-meta);
}
</style>
