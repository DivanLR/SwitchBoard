<script setup lang="ts">
defineProps<{
  testid: string
  title: string
  sub?: string
  ringTestid?: string
}>()
</script>

<template>
  <Teleport to="body">
    <div
      class="wait overlay"
      role="status"
      aria-live="polite"
      aria-busy="true"
      :data-testid="testid"
    >
      <span class="ui-spinner wait-ring" :data-testid="ringTestid"></span>
      <div class="wait-text">{{ title }}</div>
      <div v-if="sub" class="wait-sub">{{ sub }}</div>
    </div>
  </Teleport>
</template>

<style scoped>
.wait {
  /* z-index 100, above the base .overlay's 40: this is a blocking wait state and
     must outrank ToastHost (60) and the command palette (45) too. */
  z-index: 100;
  flex-direction: column;
  gap: 14px;
}

.wait-ring {
  width: 26px;
  height: 26px;
}

.wait-text {
  font-size: var(--fs-body);
  color: var(--text-bright);
}

.wait-sub {
  font-size: var(--fs-meta);
  color: var(--text-faint);
}

</style>
