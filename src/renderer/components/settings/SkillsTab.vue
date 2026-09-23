<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { CustomSkill } from '@shared/domain'
import { readSkillSource } from '@shared/skill-source'
import { useSkillsStore } from '@renderer/stores/skills'
import Icon from '@renderer/components/Icon.vue'

const skills = useSkillsStore()

const skillUrl = ref('')

const skillSource = computed(() =>
  skillUrl.value.trim() === '' ? null : readSkillSource(skillUrl.value),
)

const skillSourceParts = computed(() => {
  const parsed = skillSource.value
  if (!parsed?.ok) return null
  const { owner, repo, ref: gitRef, path } = parsed.source
  return [
    { label: 'repository', value: `${owner}/${repo}` },
    { label: 'branch', value: gitRef ?? 'default branch' },
    { label: 'folder', value: path === '' ? 'whole repository' : path },
  ]
})

async function importSkills(): Promise<void> {
  const url = skillUrl.value.trim()
  if (!url || skills.importing || skillSource.value?.ok !== true) return
  if (await skills.import(url)) skillUrl.value = ''
}

const skillsBySource = computed(() => {
  const groups = new Map<string, CustomSkill[]>()
  for (const skill of skills.items) {
    const parsed = readSkillSource(skill.sourceUrl)
    const label = parsed.ok ? `${parsed.source.owner}/${parsed.source.repo}` : skill.sourceUrl
    const list = groups.get(label)
    if (list) list.push(skill)
    else groups.set(label, [skill])
  }
  return [...groups].map(([label, items]) => {
    const on = items.filter((skill) => skill.enabled).length
    return { label, items, on, allOn: on === items.length }
  })
})

onMounted(() => {
  void skills.load()
})
</script>

<template>
  <div class="ui-kicker group-label">IMPORT FROM GITHUB</div>
  <div class="group-desc">
    Paste a repository, or a folder inside one, and every skill under it is imported. Skills are
    user-level: switching one on makes it a slash command in every project and every session.
  </div>

  <div class="add-cmd">
    <Icon name="download" class="add-cmd-plus" />
    <input
      v-model="skillUrl"
      class="add-cmd-input mono"
      :class="{ bad: skillSource?.ok === false }"
      data-testid="skills-url-input"
      placeholder="https://github.com/owner/repo/tree/main/skills"
      :disabled="skills.importing"
      :aria-invalid="skillSource?.ok === false ? 'true' : 'false'"
      :aria-describedby="skillSource ? 'skills-url-reading' : undefined"
      @keydown.enter="importSkills"
    />
    <button
      class="btn-quiet"
      data-testid="skills-import-btn"
      :disabled="skills.importing || skillSource?.ok !== true"
      @click="importSkills"
    >
      {{ skills.importing ? 'Importing…' : 'Import' }}
    </button>
  </div>

  <div v-if="skillSource" id="skills-url-reading" class="skill-reading" aria-live="polite">
    <div v-if="skillSourceParts" class="skill-reading-parts" data-testid="skills-url-reading">
      <span v-for="part in skillSourceParts" :key="part.label" class="skill-part">
        <span class="skill-part-label mono">{{ part.label }}</span>
        <span class="skill-part-value mono">{{ part.value }}</span>
      </span>
    </div>
    <div v-else class="skill-reading-bad" data-testid="skills-url-problem">
      <Icon name="warning" :size="11" />
      {{ skillSource.ok === false ? skillSource.message : '' }}
    </div>
  </div>

  <div class="group-desc skills-caution">
    <Icon name="warning" :size="11" /> A skill is a set of instructions a session will follow.
    Import from repositories you trust, and read a skill before switching it on.
  </div>

  <div v-if="skills.error" class="skills-err" data-testid="skills-settings-error">
    {{ skills.error }}
  </div>
  <div
    v-if="skills.lastImport && skills.lastImport.skipped.length > 0"
    class="skills-skipped"
    data-testid="skills-skipped"
  >
    <div class="skipped-head mono">
      Skipped {{ skills.lastImport.skipped.length }} of
      {{ skills.lastImport.skipped.length + skills.lastImport.imported.length }}
    </div>
    <div v-for="s in skills.lastImport.skipped" :key="s.name" class="skipped-one">
      <span class="skipped-name mono">{{ s.name }}</span>
      <span class="skipped-why">{{ s.reason }}</span>
    </div>
  </div>

  <div class="ui-kicker group-label skills-list-label">IMPORTED SKILLS</div>
  <div v-if="skills.items.length === 0" class="group-desc" data-testid="skills-none">None yet.</div>

  <div
    v-for="group in skillsBySource"
    :key="group.label"
    class="skill-group"
    :data-testid="`skill-group-${group.label}`"
  >
    <div class="skill-group-head">
      <span class="skill-group-name mono">{{ group.label }}</span>
      <span class="skill-group-count mono">{{ group.on }}/{{ group.items.length }} on</span>
      <button
        v-if="group.items.length > 1"
        class="skill-group-all"
        :data-testid="`skill-group-all-${group.label}`"
        :title="`Switch every skill from ${group.label} on or off`"
        @click="
          skills.setGroupEnabled(
            group.items.filter((s) => s.enabled === group.allOn).map((s) => s.name),
            !group.allOn,
          )
        "
      >
        {{ group.allOn ? 'all off' : 'all on' }}
      </button>
    </div>

    <div
      v-for="skill in group.items"
      :key="skill.name"
      class="ui-card setting-row is-actionable"
      :data-testid="`skill-row-${skill.name}`"
    >
      <div class="sr-text">
        <div class="sr-label mono">/{{ skill.name }}</div>
        <div class="sr-desc">{{ skill.description || 'No description in its SKILL.md.' }}</div>
        <div class="sr-desc skills-origin mono">
          {{ skill.sourcePath || 'repository root' }} · {{ skill.fileCount }} file{{
            skill.fileCount === 1 ? '' : 's'
          }}
        </div>
      </div>
      <div class="skills-actions">
        <button
          class="switch"
          :class="{ on: skill.enabled }"
          role="switch"
          :aria-checked="skill.enabled"
          :data-testid="`skill-toggle-${skill.name}`"
          :title="
            skill.enabled
              ? 'On: every session can use this skill. Turning it off removes it from ~/.claude/skills.'
              : 'Off: no session can see this skill. Turning it on copies it into ~/.claude/skills.'
          "
          @click="skills.setEnabled(skill.name, !skill.enabled)"
        >
          <span class="knob"></span>
        </button>
        <button
          class="skills-remove"
          :data-testid="`skill-remove-${skill.name}`"
          :aria-label="`Remove ${skill.name}`"
          title="Remove this skill and delete its files"
          @click="skills.remove(skill.name)"
        >
          <Icon name="trash" :size="12" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.add-cmd-input.bad {
  color: var(--amber-ink);
}

.skill-reading {
  margin-top: 6px;
  font-size: var(--fs-micro);
}

.skill-reading-parts {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
}

.skill-part {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  min-width: 0;
}

.skill-part-label {
  letter-spacing: 0.05em;
  color: var(--text-ghost);
}

.skill-part-value {
  color: var(--text-name);
  overflow-wrap: anywhere;
}

.skill-reading-bad {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--amber);
}

.skills-caution {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  color: var(--amber);
}

.skills-err {
  margin-top: 8px;
  font-size: var(--fs-meta);
  color: var(--red);
}

.skills-skipped {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 8px;
  font-size: var(--fs-micro);
  color: var(--text-faint);
}

.skipped-head {
  color: var(--text-mid);
}

.skipped-one {
  display: flex;
  gap: 8px;
}

.skipped-name {
  color: var(--text-name);
}

.skills-list-label {
  margin-top: 12px;
}

.skill-group {
  margin-bottom: 14px;
}

.skill-group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--border-soft);
  margin-bottom: 2px;
  font-size: var(--fs-micro);
}

.skill-group-name {
  color: var(--text-name);
  overflow-wrap: anywhere;
}

.skill-group-count {
  color: var(--text-ghost);
}

.skill-group-all {
  margin-left: auto;
  padding: 1px 6px;
  font-size: var(--fs-micro);
  letter-spacing: 0.05em;
  color: var(--text-faint);
  background: var(--bg-hover);
  border: 1px solid var(--border-card);
  border-radius: var(--r-row);
}

.skill-group-all:hover {
  color: var(--text-bright);
  border-color: var(--blue);
}

.skills-origin {
  font-size: var(--fs-micro);
  color: var(--text-ghost);
}

.skills-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.skills-remove {
  display: inline-flex;
  padding: 3px;
  color: var(--text-faint);
  background: none;
  border: 0;
  cursor: pointer;
}

.skills-remove:hover {
  color: var(--red);
}
</style>
