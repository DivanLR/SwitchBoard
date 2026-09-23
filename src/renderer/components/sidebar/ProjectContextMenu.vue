<script setup lang="ts">
import type { ProjectGroup } from '@shared/domain'
import Icon from '@renderer/components/Icon.vue'

export interface ContextTarget {
  kind: 'project' | 'group'
  id: string
  name: string
  x: number
  y: number
}

defineProps<{
  menu: ContextTarget
  groups: ProjectGroup[]
  grouped: boolean
  liveCount: number
}>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'rename'): void
  (e: 'move', delta: number): void
  (e: 'new-session'): void
  (e: 'end-all'): void
  (e: 'repoint'): void
  (e: 'new-group'): void
  (e: 'assign', groupId: string | null): void
  (e: 'remove'): void
  (e: 'delete'): void
  (e: 'remove-group'): void
}>()
</script>

<template>
  <div class="ctx-catcher" data-testid="project-ctx-catcher" @click="emit('close')" @contextmenu.prevent="emit('close')">
    <div
      class="ctx-menu"
      data-testid="project-ctx-menu"
      :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
      @click.stop
    >
      <div class="ctx-name mono">{{ menu.name }}</div>
      <button class="ctx-item" data-testid="ctx-rename" @click="emit('rename')">
        <span class="icon-accent"><Icon name="pencil" /></span>Rename
      </button>
      <button class="ctx-item" data-testid="ctx-move-up" @click="emit('move', -1)">
        <span><Icon name="arrow-up" /></span>Move up
      </button>
      <button class="ctx-item" data-testid="ctx-move-down" @click="emit('move', 1)">
        <span><Icon name="arrow-down" /></span>Move down
      </button>
      <template v-if="menu.kind === 'project'">
        <button class="ctx-item" data-testid="ctx-new-session" @click="emit('new-session')">
          <span class="icon-accent"><Icon name="plus" /></span>New session here
        </button>
        <button
          v-if="liveCount > 1"
          class="ctx-item"
          data-testid="ctx-end-all"
          @click="emit('end-all')"
        >
          <span class="icon-danger"><Icon name="stop" /></span>End all {{ liveCount }} sessions
        </button>
        <div class="ctx-sep"></div>
        <button class="ctx-item" data-testid="ctx-repoint" @click="emit('repoint')">
          <span class="icon-accent"><Icon name="swap" /></span>Change folder…
        </button>
        <div class="ctx-sep"></div>
        <button class="ctx-item" data-testid="ctx-new-group" @click="emit('new-group')">
          <span class="icon-accent"><Icon name="grid" /></span>New group with this
        </button>
        <button
          v-for="g in groups"
          :key="g.id"
          class="ctx-item"
          :data-testid="`ctx-move-to-${g.name}`"
          @click="emit('assign', g.id)"
        >
          <span><Icon name="arrow-right" /></span>Move to {{ g.name }}
        </button>
        <button
          v-if="grouped"
          class="ctx-item"
          data-testid="ctx-move-to-ungrouped"
          @click="emit('assign', null)"
        >
          <span><Icon name="arrow-right" /></span>Move out of group
        </button>
        <div class="ctx-sep"></div>
        <button class="ctx-item" data-testid="ctx-remove" @click="emit('remove')">
          <span><Icon name="folder" /></span>Archive
        </button>
        <button class="ctx-item danger" data-testid="ctx-delete" @click="emit('delete')">
          <span><Icon name="trash" /></span>Delete from Switchboard…
        </button>
      </template>
      <button
        v-else
        class="ctx-item danger"
        data-testid="ctx-remove-group"
        @click="emit('remove-group')"
      >
        <span><Icon name="trash" /></span>Remove group (keeps projects)
      </button>
    </div>
  </div>
</template>

<style scoped>
.icon-accent {
  color: var(--green);
}

.icon-danger {
  color: var(--red);
}

.ctx-menu {
  position: fixed;
  min-width: 180px;
  background: var(--bg-panel-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-panel);
  overflow: hidden;
  box-shadow: var(--shadow-menu);
  animation: sbIn 0.12s var(--ease);
}

html.sb-light .ctx-menu {
  background: var(--bg-card);
}

.ctx-name {
  padding: 8px 13px 6px;
  font-size: var(--fs-micro);
  letter-spacing: 0.12em;
  color: var(--text-faint);
  border-bottom: 1px solid color-mix(in srgb, var(--green) 18%, transparent);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ctx-sep {
  height: 1px;
  margin: 3px 0;
  background: color-mix(in srgb, var(--green) 18%, transparent);
}

.ctx-item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 9px 13px;
  font-size: var(--fs-ui);
  color: var(--text-body);
  cursor: pointer;
  background: transparent;
}

.ctx-item:hover {
  background: color-mix(in srgb, var(--green) 10%, transparent);
  color: var(--text-strong);
}

.ctx-item.danger:hover {
  background: color-mix(in srgb, var(--red) 8%, transparent);
  color: var(--red);
}
</style>
