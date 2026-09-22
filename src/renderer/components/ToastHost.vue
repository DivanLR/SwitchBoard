<script setup lang="ts">
import { useToastsStore } from '@renderer/stores/toasts'
import Icon from '@renderer/components/Icon.vue'

const toasts = useToastsStore()

const ICONS: Record<string, string> = {
  success: 'check',
  error: 'warning',
  warning: 'warning',
  info: 'circle',
}
</script>

<template>
  <div class="toast-host" role="log" aria-live="polite" data-testid="toast-host">
    <TransitionGroup name="toast">
      <div
        v-for="t in toasts.items"
        :key="t.id"
        class="toast"
        :class="t.kind"
        role="status"
        :data-testid="`toast-${t.kind}`"
        @mouseenter="toasts.pause(t.id)"
        @mouseleave="toasts.resume(t.id)"
      >
        <span class="t-icon" aria-hidden="true"><Icon :name="ICONS[t.kind]" :size="16" /></span>
        <div class="t-body">
          <div class="t-title">{{ t.title }}</div>
          <div v-if="t.message" class="t-msg">{{ t.message }}</div>
        </div>
        <button
          type="button"
          class="t-x"
          :data-testid="`toast-dismiss-${t.id}`"
          aria-label="Dismiss"
          @click="toasts.dismiss(t.id)"
        >
          <Icon name="close" :size="11" />
        </button>
        <span
          v-if="t.duration > 0"
          class="t-progress"
          :style="{ animationDuration: `${t.duration}ms` }"
        ></span>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-host {
  position: fixed;
  top: 52px;
  right: 16px;
  z-index: 60;
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(360px, calc(100vw - 32px));
  pointer-events: none;
}

.toast {
  position: relative;
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: start;
  gap: 10px;
  padding: var(--pad-card);
  overflow: hidden;
  pointer-events: auto;
  background: var(--surface-overlay);
  border: 1px solid var(--border-card);
  border-radius: var(--r-panel);
  box-shadow: var(--shadow-toast);
}

.toast.success .t-icon,
.toast.success .t-progress {
  color: var(--green);
  background-color: var(--green);
}
.toast.error .t-icon,
.toast.error .t-progress {
  color: var(--red);
  background-color: var(--red);
}
.toast.warning .t-icon,
.toast.warning .t-progress {
  color: var(--amber);
  background-color: var(--amber);
}
.toast.info .t-icon,
.toast.info .t-progress {
  color: var(--teal);
  background-color: var(--teal);
}

.t-icon {
  display: inline-flex;
  padding-top: 1px;
  background-color: transparent !important;
}

.t-body {
  min-width: 0;
}

.t-title {
  font-size: var(--fs-ui);
  font-weight: var(--w-em);
  color: var(--text-strong);
}

.t-msg {
  margin-top: 2px;
  font-size: var(--fs-meta);
  line-height: 1.45;
  color: var(--text-meta);
  overflow-wrap: anywhere;
}

.t-x {
  display: inline-flex;
  padding: 2px;
  color: var(--text-faint);
  background: none;
  border: 0;
  cursor: pointer;
}

.t-x:hover {
  color: var(--text-strong);
}

.t-progress {
  position: absolute;
  left: 0;
  bottom: 0;
  height: 2px;
  width: 100%;
  transform-origin: left;
  animation: toastCountdown linear forwards;
}

.toast:hover .t-progress {
  animation-play-state: paused;
}

@keyframes toastCountdown {
  from {
    transform: scaleX(1);
  }
  to {
    transform: scaleX(0);
  }
}

.toast-enter-active {
  transition:
    transform var(--dur-toast-in) var(--ease-toast-in),
    opacity var(--dur-toast-in) var(--ease-toast-in);
}

.toast-leave-active {
  transition:
    transform var(--dur-toast-out) var(--ease-toast-out),
    opacity var(--dur-toast-out) var(--ease-toast-out);
  position: absolute;
  right: 0;
  width: 100%;
}

.toast-enter-from {
  opacity: 0;
  transform: translateX(100%) scale(0.95);
}

.toast-leave-to {
  opacity: 0;
  transform: translateX(40%);
}

.toast-move {
  transition: transform var(--dur-toast-out) var(--ease-overlay);
}

@media (prefers-reduced-motion: reduce) {
  .toast-enter-active,
  .toast-leave-active,
  .toast-move {
    transition: opacity 120ms linear;
  }
  .toast-enter-from,
  .toast-leave-to {
    transform: none;
  }
  .t-progress {
    animation: none;
    opacity: 0.5;
  }
}
</style>
