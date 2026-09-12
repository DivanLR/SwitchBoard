<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { CustomSkill } from '@shared/domain'
import { useSettingsStore } from '@renderer/stores/settings'
import { useSkillsStore } from '@renderer/stores/skills'
import MiniTerminal from '@renderer/components/MiniTerminal.vue'
import Icon from '@renderer/components/Icon.vue'

const props = defineProps<{
  projectId: string
  projectName: string
  sessionId?: string | null
}>()

const emit = defineEmits<{ (e: 'ran', sessionId: string): void; (e: 'manage'): void }>()

const skills = useSkillsStore()
const settings = useSettingsStore()

onMounted(() => {
  void skills.load()
  if (!settings.settings) void settings.load()
})

const argFor = ref<string | null>(null)
const argument = ref('')
const running = ref<string | null>(null)


const favouriteNames = computed<string[]>(() => settings.settings?.favouriteSkills ?? [])

const favouriteSet = computed(() => new Set(favouriteNames.value))

const isFavourite = (name: string): boolean => favouriteSet.value.has(name)

function toggleFavourite(name: string): void {
  const next = favouriteNames.value.filter((n) => n !== name)
  if (next.length === favouriteNames.value.length) next.push(name)
  void settings.save({ favouriteSkills: next })
}

const favourites = computed<CustomSkill[]>(() =>
  favouriteNames.value
    .map((name) => skills.enabled.find((skill) => skill.name === name))
    .filter((skill): skill is CustomSkill => skill !== undefined),
)

const bySource = computed<{ source: string; items: CustomSkill[] }[]>(() => {
  const groups = new Map<string, CustomSkill[]>()
  for (const skill of skills.enabled) {
    if (favouriteSet.value.has(skill.name)) continue
    const list = groups.get(skill.sourceUrl)
    if (list) list.push(skill)
    else groups.set(skill.sourceUrl, [skill])
  }
  return [...groups].map(([source, items]) => ({ source, items }))
})

function shortSource(url: string): string {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean)
    return parts.slice(0, 2).join('/') || url
  } catch {
    return url
  }
}

const sections = computed(() => [
  ...(favourites.value.length > 0
    ? 
      [{ key: 'favourites', label: 'Favourites', favourite: true, items: favourites.value }]
    : []),
  ...bySource.value.map((group) => ({
    key: group.source,
    label: shortSource(group.source),
    favourite: false,
    items: group.items,
  })),
])

function openArgument(name: string): void {
  argFor.value = argFor.value === name ? null : name
  argument.value = ''
}

async function run(name: string): Promise<void> {
  running.value = name
  try {
    const sessionId = await skills.run(props.projectId, name, argFor.value === name ? argument.value : undefined)
    if (sessionId) {
      argFor.value = null
      argument.value = ''
      emit('ran', sessionId)
    }
  } finally {
    running.value = null
  }
}
</script>

<template>
  <div class="skills" data-testid="skills-view">
    <div class="intro">
      Skills you imported yourself, runnable against
      <span class="proj">{{ projectName }}</span
      >. Each one runs in the Skills section's own session. Star the ones you reach for and
      they sit at the top.
      <button class="manage" data-testid="skills-manage" @click="emit('manage')">
        <Icon name="settings" :size="11" /> Manage skills
      </button>
    </div>

    <div v-if="skills.error" class="err" data-testid="skills-error">{{ skills.error }}</div>

    <div v-if="skills.items.length === 0" class="empty mono" data-testid="skills-empty">
      No skills imported yet. Add a GitHub repository in Settings → Skills and they appear here.
    </div>
    <div v-else-if="skills.enabled.length === 0" class="empty mono" data-testid="skills-all-off">
      All {{ skills.items.length }} imported skills are switched off. Turn one on in Settings → Skills.
    </div>

    <div
      v-for="group in sections"
      :key="group.key"
      class="group"
      :class="{ fav: group.favourite }"
      :data-testid="group.favourite ? 'skills-favourites' : `skills-source-${group.key}`"
    >
      <div class="group-head">
        <Icon v-if="group.favourite" name="star" :size="11" class="group-star" />
        <span class="group-name" :class="{ mono: !group.favourite }">{{ group.label }}</span>
        <span class="group-tag">{{ group.items.length }} skill{{ group.items.length === 1 ? '' : 's' }}</span>
      </div>

      <div class="cmd-list">
        <div v-for="skill in group.items" :key="skill.name" class="cmd-wrap">
          <button
            class="cmd-fav"
            :class="{ on: isFavourite(skill.name) }"
            :data-testid="`skill-fav-${skill.name}`"
            :aria-pressed="isFavourite(skill.name)"
            :title="
              isFavourite(skill.name)
                ? `Unpin ${skill.name} from the top`
                : `Pin ${skill.name} to the top`
            "
            @click="toggleFavourite(skill.name)"
          >
            <Icon name="star" :size="11" />
          </button>
          <button
            class="cmd-row"
            :data-testid="`skill-run-${skill.name}`"
            :disabled="running !== null"
            @click="run(skill.name)"
          >
            <span class="cmd-name mono">/{{ skill.name }}</span>
            <span class="cmd-desc">{{ skill.description || 'No description in its SKILL.md.' }}</span>
            <span class="cmd-run">
              <template v-if="running === skill.name">Sending…</template>
              <template v-else>Run</template>
            </span>
          </button>
          <button
            class="cmd-arg"
            :data-testid="`skill-arg-${skill.name}`"
            :class="{ on: argFor === skill.name }"
            title="Add an argument for this skill"
            @click="openArgument(skill.name)"
          >
            <Icon name="plus" :size="11" />
          </button>
          <input
            v-if="argFor === skill.name"
            v-model="argument"
            class="arg-input mono"
            :data-testid="`skill-arg-input-${skill.name}`"
            placeholder="Argument, then Enter to run"
            @keydown.enter.prevent="run(skill.name)"
            @keydown.esc="argFor = null"
          />
        </div>
      </div>
    </div>

    <MiniTerminal v-if="sessionId" :session-id="sessionId" label="running" />
  </div>
</template>

<style scoped>
.skills {
  flex: 1;
  overflow-y: auto;
  padding: 18px 22px 52px;
}

.intro {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 16px;
  font-size: var(--fs-ui);
  color: var(--text-mid);
}

.proj {
  color: var(--text-strong);
  font-family: var(--mono);
}

.manage {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  font-size: var(--fs-meta);
  color: var(--text-tab);
  background: none;
  border: 1px solid var(--border-seg);
  border-radius: var(--rp);
  cursor: pointer;
}

.manage:hover {
  color: var(--text-strong);
  border-color: var(--border-strong);
}

.err {
  margin-bottom: 12px;
  font-size: var(--fs-meta);
  color: var(--red);
}

.empty {
  padding: 20px 0;
  font-size: var(--fs-meta);
  color: var(--text-faint);
}

.group {
  margin-bottom: 20px;
}

.group-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 8px;
}

.group-name {
  font-size: var(--fs-ui);
  color: var(--text-strong);
}

.group-tag {
  font-size: var(--fs-micro);
  color: var(--text-faint);
}

.cmd-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.cmd-wrap {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 4px;
}

.cmd-fav {
  display: flex;
  align-items: center;
  padding: 0 7px;
  color: var(--text-ghost);
  background: var(--bg-card);
  border: 1px solid var(--border-card);
  border-radius: var(--rc);
  cursor: pointer;
}

.cmd-fav:hover {
  color: var(--teal);
  border-color: var(--border-strong);
}

.cmd-fav.on {
  color: var(--teal);
  border-color: var(--teal);
}

.group-star {
  color: var(--teal);
}

.group.fav .group-head {
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border-soft);
}

.group.fav .group-name {
  color: var(--text-strong);
}

.cmd-row {
  display: grid;
  grid-template-columns: minmax(140px, auto) 1fr auto;
  align-items: baseline;
  gap: 12px;
  padding: var(--pad-card);
  text-align: left;
  background: var(--bg-card);
  border: 1px solid var(--border-card);
  border-radius: var(--rc);
  cursor: pointer;
}

.cmd-row:hover:not(:disabled) {
  border-color: var(--border-strong);
}

.cmd-row:disabled {
  opacity: 0.6;
  cursor: default;
}

.cmd-name {
  font-size: var(--fs-ui);
  color: var(--text-strong);
}

.cmd-desc {
  font-size: var(--fs-meta);
  color: var(--text-meta);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cmd-run {
  font-size: var(--fs-micro);
  color: var(--green);
}

.cmd-arg {
  padding: 0 9px;
  color: var(--text-faint);
  background: var(--bg-card);
  border: 1px solid var(--border-card);
  border-radius: var(--rc);
  cursor: pointer;
}

.cmd-arg:hover,
.cmd-arg.on {
  color: var(--text-strong);
  border-color: var(--border-strong);
}

.arg-input {
  grid-column: 2 / -1;
  padding: 6px 8px;
  font-size: var(--fs-meta);
  color: var(--text);
  background: var(--bg-code);
  border: 1px solid var(--border);
  border-radius: var(--rp);
}

.arg-input:focus {
  outline: none;
  border-color: var(--green);
}
</style>
