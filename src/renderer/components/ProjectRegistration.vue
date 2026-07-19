<script setup lang="ts">
// Registration dialog (FR-001/001a) styled to the Switchboard design language:
// Claude Code suggestions with confirm-to-add, manual path entry, and
// duplicate / missing-path error states.
import { onMounted, ref } from 'vue'
import { isIpcError } from '@shared/ipc-types'
import { useProjectsStore } from '@renderer/stores/projects'

const projects = useProjectsStore()
const emit = defineEmits<{ (e: 'close'): void }>()

const manualPath = ref('')
const manualName = ref('')
const error = ref<string | null>(null)
const busy = ref(false)

onMounted(() => {
  void projects.loadSuggestions()
})

async function add(path: string, name?: string): Promise<void> {
  error.value = null
  busy.value = true
  try {
    await projects.register(path, name)
    manualPath.value = ''
    manualName.value = ''
  } catch (e) {
    if (isIpcError(e)) {
      error.value =
        e.code === 'DUPLICATE'
          ? 'That folder is already registered.'
          : e.code === 'INVALID_PATH'
            ? 'That folder does not exist.'
            : e.message
    } else {
      error.value = String(e)
    }
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="dialog reg" data-testid="registration-dialog">
      <div class="head">
        <div class="title mono"><span style="color: var(--green)">▣</span> Add a project</div>
        <button class="btn-outline" @click="emit('close')">Close</button>
      </div>

      <p v-if="error" class="error mono" data-testid="registration-error">{{ error }}</p>

      <section>
        <div class="section-label mono">SUGGESTED · Claude Code has been used here</div>
        <div v-if="projects.suggestions.length === 0" class="none mono">No suggestions found.</div>
        <div
          v-for="s in projects.suggestions"
          :key="s.path"
          class="suggestion"
          :data-testid="`suggestion-${s.name}`"
        >
          <div class="s-meta">
            <div class="s-name mono">{{ s.name }}</div>
            <div class="s-path mono">{{ s.path }}</div>
          </div>
          <button class="btn-solid" :disabled="busy" @click="add(s.path, s.name)">Add</button>
        </div>
      </section>

      <section>
        <div class="section-label mono">ADD MANUALLY</div>
        <div class="manual">
          <input
            v-model="manualPath"
            class="mono"
            data-testid="manual-path"
            placeholder="C:\path\to\project"
            spellcheck="false"
          />
          <input
            v-model="manualName"
            class="mono"
            data-testid="manual-name"
            placeholder="Display name (optional)"
          />
          <button
            class="btn-solid"
            data-testid="manual-add"
            :disabled="busy || manualPath.trim().length === 0"
            @click="add(manualPath.trim(), manualName.trim() || undefined)"
          >
            Add folder
          </button>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.reg {
  width: 560px;
  max-height: 80vh;
  overflow-y: auto;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-bright);
}

.section-label {
  font-size: 10px;
  letter-spacing: 0.13em;
  color: var(--text-faint);
  margin: 18px 0 8px;
}

.none {
  font-size: 11.5px;
  color: var(--text-faint);
}

.suggestion {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px solid var(--border-hist);
}

.s-meta {
  min-width: 0;
}

.s-name {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text-name);
}

.s-path {
  font-size: 10.5px;
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.manual {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.manual input {
  font-size: 12px;
}

.error {
  color: var(--red);
  font-size: 12px;
  margin: 8px 0 0;
}
</style>
