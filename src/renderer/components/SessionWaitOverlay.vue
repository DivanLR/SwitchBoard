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
      class="wait"
      role="status"
      aria-live="polite"
      aria-busy="true"
      :data-testid="testid"
    >
      <span class="wait-ring" :data-testid="ringTestid"></span>
      <div class="wait-text mono">{{ title }}</div>
      <div v-if="sub" class="wait-sub">{{ sub }}</div>
    </div>
  </Teleport>
</template>

<style scoped>
.wait {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  background: var(--scrim);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}

.wait-ring {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 2px solid var(--border-strong);
  border-top-color: var(--green);
  animation: wait-spin 0.7s linear infinite;
}

.wait-text {
  font-size: var(--fs-body);
  color: var(--text-bright);
}

.wait-sub {
  font-size: var(--fs-meta);
  color: var(--text-faint);
}

@keyframes wait-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .wait-ring {
    animation: none;
    opacity: 0.6;
  }
}
</style>
