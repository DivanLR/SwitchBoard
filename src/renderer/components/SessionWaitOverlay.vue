<script setup lang="ts">
// The one full-window wait in this app. Starting a session and ending one are
// the same kind of interruption — the CLI is being spawned or drained, a
// container is being built or torn down, and nothing the developer clicks in
// between will land — so they get the same screen rather than two.
//
// They used to differ: start took a blurred scrim with a spinning ring, end took
// a bottom-anchored card with a sliding rule and no blur. Two treatments for one
// state read as two different things happening.
//
// The start treatment won. Its scrim + blur is the same mechanism `.overlay`
// uses for every dialog in the app, and its ring is the same motif GlobalSpinner
// already uses for work in flight, so the wait now looks like the rest of the
// app instead of like a third idea.
//
// Teleported here rather than at each call site, so a caller is a plain v-if and
// no ancestor's stacking context or overflow can clip it.
defineProps<{
  /** The wrapper's testid — each caller keeps the one its tests already name. */
  testid: string
  title: string
  sub?: string
  /** Testid for the ring, where a caller's tests target the moving part. */
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
/* z-index 100: above the dialog tier (40) so the New session dialog a start was
   triggered from waits behind this, and above the utility layers at 70. */
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
  /* Circular for the same reason the global spinner is: it rotates, and a
     rotating square reads as a glitch rather than as progress. */
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

/* The end overlay had this and the start one did not. Keeping it means neither
   regresses: the ring still has to be visible when it stops turning. */
@media (prefers-reduced-motion: reduce) {
  .wait-ring {
    animation: none;
    opacity: 0.6;
  }
}
</style>
