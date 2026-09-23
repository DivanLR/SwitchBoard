<script setup lang="ts">
import { computed, useTemplateRef } from 'vue'
import { useModal } from '@renderer/composables/useModal'
import { useInboxStore } from '@renderer/stores/inbox'
import { useElicitationsStore } from '@renderer/stores/elicitations'
import FlowView from '@renderer/views/FlowView.vue'
import Icon from '@renderer/components/Icon.vue'
import ElicitationCard from '@renderer/components/ElicitationCard.vue'

const props = defineProps<{ projectId: string; projectName: string }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const dialogEl = useTemplateRef<HTMLElement>('dialog')
useModal(dialogEl, () => emit('close'))

const inbox = useInboxStore()
const elicitations = useElicitationsStore()
const waiting = computed(
  () => inbox.pending.filter((item) => item.projectId === props.projectId).length,
)
const asks = computed(() => elicitations.flowFor(props.projectId))
</script>

<template>
  <div class="overlay" data-testid="flow-popup" @click.self="emit('close')">
    <div
      ref="dialog"
      class="dialog flow-dialog"
      role="dialog"
      aria-modal="true"
      :aria-label="`Flow for ${projectName}`"
      tabindex="-1"
    >
      <div class="fd-head">
        <span class="fd-title">Flow</span>
        <span class="fd-project">{{ projectName }}</span>
        <span class="fd-spacer"></span>
        <button
          v-if="waiting > 0"
          type="button"
          class="btn-outline fd-inbox"
          data-testid="flow-popup-inbox"
          :title="`${waiting} waiting in the inbox — close Flow to answer`"
          @click="emit('close')"
        >
          <Icon name="comment" :size="12" />
          {{ waiting }} waiting
        </button>
        <button
          type="button"
          class="btn-quiet"
          data-testid="flow-popup-close"
          aria-label="Close Flow"
          title="Close (Escape)"
          @click="emit('close')"
        >
          <Icon name="close" />
        </button>
      </div>
      <div v-if="asks.length > 0" class="fd-asks" data-testid="flow-popup-asks" aria-live="polite">
        <ElicitationCard v-for="item in asks" :key="item.id" :item="item" />
      </div>
      <div class="fd-body">
        <FlowView :project-id="projectId" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.flow-dialog {
  display: flex;
  flex-direction: column;
  width: 96vw;
  height: 92vh;
  max-width: 1680px;
  padding: 0;
  overflow: hidden;
}

.fd-head {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
  padding: var(--sp-4) var(--sp-5) var(--sp-3);
  border-bottom: 1px solid var(--border);
}

.fd-title {
  font-size: var(--fs-title);
  font-weight: var(--w-em);
  color: var(--text-strong);
}

.fd-project {
  font-size: var(--fs-micro);
  color: var(--text-meta);
}

.fd-spacer {
  flex: 1;
}

.fd-asks {
  max-height: 40vh;
  overflow-y: auto;
  padding: var(--sp-4) var(--sp-5) 0;
  border-bottom: 1px solid var(--border);
}

.fd-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
</style>
