<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

const visible = ref(false)
let showTimer: ReturnType<typeof setTimeout> | undefined
let hideTimer: ReturnType<typeof setTimeout> | undefined
let shownAt = 0
let unsubscribe: (() => void) | undefined

const SHOW_DELAY = 150 
const MIN_VISIBLE = 350 

function onPending(pending: number): void {
  if (pending > 0) {
    if (visible.value || showTimer) return
    clearTimeout(hideTimer)
    showTimer = setTimeout(() => {
      showTimer = undefined
      visible.value = true
      shownAt = Date.now()
    }, SHOW_DELAY)
  } else {
    if (showTimer) {
      clearTimeout(showTimer)
      showTimer = undefined
      return
    }
    if (!visible.value) return
    const remaining = Math.max(0, MIN_VISIBLE - (Date.now() - shownAt))
    hideTimer = setTimeout(() => (visible.value = false), remaining)
  }
}

onMounted(() => {
  unsubscribe = window.switchboard.onLoading?.(onPending)
})
onUnmounted(() => {
  unsubscribe?.()
  clearTimeout(showTimer)
  clearTimeout(hideTimer)
})
</script>

<template>
  <transition name="spin-fade">
    <div v-if="visible" class="global-spinner" data-testid="global-spinner" aria-label="Loading">
      <span class="gs-ring"></span>
    </div>
  </transition>
</template>

<style scoped>
.global-spinner {
  position: fixed;
  bottom: 16px;
  right: 16px;
  z-index: 200;
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--rp);
  background: var(--bg-panel);
  border: 1px solid var(--border-strong);
  box-shadow: var(--shadow-dd);
  pointer-events: none;
}

.gs-ring {
  width: 15px;
  height: 15px;
  border-radius: 50%;
  border: 2px solid var(--border-strong);
  border-top-color: var(--green);
  animation: gs-spin 0.7s linear infinite;
}

@keyframes gs-spin {
  to {
    transform: rotate(360deg);
  }
}

.spin-fade-enter-active,
.spin-fade-leave-active {
  transition: opacity 0.15s var(--ease);
}

.spin-fade-enter-from,
.spin-fade-leave-to {
  opacity: 0;
}
</style>
