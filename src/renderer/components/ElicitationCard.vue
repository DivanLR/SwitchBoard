<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import type { Elicitation, ElicitationAnswer, ElicitationValues } from '@shared/domain'
import { useElicitationsStore } from '@renderer/stores/elicitations'
import Icon from '@renderer/components/Icon.vue'

const props = defineProps<{ item: Elicitation; project?: string }>()
const elicitations = useElicitationsStore()

const values = reactive<ElicitationValues>(
  Object.fromEntries(
    props.item.fields
      .filter((field) => field.kind !== 'unsupported')
      .map((field) => [field.name, field.initial ?? (field.kind === 'boolean' ? false : '')]),
  ),
)
const error = ref<string | null>(null)
const busy = ref(false)

const url = computed(() => props.item.mode === 'url')
const headline = computed(
  () => props.item.title ?? (url.value ? `${props.item.server} wants you to sign in` : `${props.item.server} needs an answer`),
)
const serverLabel = computed(() =>
  props.item.server === props.item.serverName ? props.item.server : `${props.item.server} (${props.item.serverName})`,
)
const blocked = computed(() => props.item.fields.some((field) => field.kind === 'unsupported' && field.required))

async function answer(action: ElicitationAnswer): Promise<void> {
  busy.value = true
  error.value = await elicitations.respond(props.item.id, action, action === 'accept' ? { ...values } : undefined)
  busy.value = false
}

async function openAgain(): Promise<void> {
  error.value = await elicitations.openAgain(props.item.id)
}
</script>

<template>
  <section
    class="ui-card is-warn el-card"
    data-testid="elicitation-card"
    :data-mode="item.mode"
    :data-elicitation-id="item.id"
    :aria-label="headline"
  >
    <div class="el-head">
      <span class="ui-kicker el-kicker">
        <Icon :name="url ? 'external' : 'comment'" :size="11" />
        {{ url ? 'Sign in' : 'Input needed' }}
      </span>
      <span class="el-server mono" data-testid="elicitation-server">{{ serverLabel }}</span>
      <span v-if="project" class="el-meta">{{ project }}</span>
    </div>
    <div class="el-title" data-testid="elicitation-title">{{ headline }}</div>
    <div v-if="item.description" class="el-text">{{ item.description }}</div>
    <div v-if="item.message" class="el-text" data-testid="elicitation-message">{{ item.message }}</div>
    <div v-if="item.intent" class="el-meta" data-testid="elicitation-intent">
      Asked while running <span class="mono el-intent">{{ item.intent.summary }}</span>
    </div>

    <template v-if="url">
      <div v-if="item.refused" class="el-bad" role="alert" data-testid="elicitation-refused">{{ item.refused }}</div>
      <div v-else class="el-text" data-testid="elicitation-host">
        Opened <span class="mono">{{ item.host }}</span> in your browser. Finish signing in there; this card closes
        when {{ item.server }} confirms it.
      </div>
      <div v-if="error" class="el-bad" role="alert" data-testid="elicitation-error">{{ error }}</div>
      <div class="el-actions">
        <button
          v-if="!item.refused"
          type="button"
          class="btn-outline"
          data-testid="elicitation-open-again"
          @click="openAgain()"
        >
          Open again
        </button>
        <button type="button" class="btn-quiet" data-testid="elicitation-cancel" :disabled="busy" @click="answer('cancel')">
          {{ item.refused ? 'Dismiss' : 'Cancel' }}
        </button>
      </div>
    </template>

    <form v-else class="el-form" @submit.prevent="answer('accept')">
      <div v-for="field in item.fields" :key="field.name" class="el-field">
        <label v-if="field.kind === 'boolean'" class="el-check">
          <input v-model="values[field.name]" type="checkbox" :data-testid="`elicitation-field-${field.name}`" />
          {{ field.label }}
        </label>
        <label v-else-if="field.kind !== 'unsupported'" class="el-label">
          <span>
            {{ field.label }}<span v-if="field.required" class="el-meta"> (required)</span>
          </span>
          <select
            v-if="field.kind === 'enum'"
            v-model="values[field.name]"
            :data-testid="`elicitation-field-${field.name}`"
          >
            <option value="" :disabled="field.required">{{ field.required ? 'Choose one' : 'None' }}</option>
            <option v-for="option in field.options" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
          <input
            v-else
            v-model="values[field.name]"
            :type="field.kind === 'string' ? 'text' : 'number'"
            :step="field.kind === 'integer' ? 1 : field.kind === 'number' ? 'any' : undefined"
            :data-testid="`elicitation-field-${field.name}`"
          />
        </label>
        <div v-else class="el-meta" :data-testid="`elicitation-field-${field.name}`">
          <span class="el-label-text">{{ field.label }}.</span> {{ field.why }}
        </div>
        <div v-if="field.description" class="el-meta">{{ field.description }}</div>
      </div>
      <div v-if="item.fields.length === 0" class="el-meta">
        The server asks for no fields: Send agrees, Decline refuses.
      </div>
      <div v-if="error" class="el-bad" role="alert" data-testid="elicitation-error">{{ error }}</div>
      <div class="el-actions">
        <button type="submit" class="btn-solid" data-testid="elicitation-accept" :disabled="busy || blocked">Send</button>
        <button type="button" class="btn-outline" data-testid="elicitation-decline" :disabled="busy" @click="answer('decline')">
          Decline
        </button>
        <button type="button" class="btn-quiet" data-testid="elicitation-cancel" :disabled="busy" @click="answer('cancel')">
          Cancel
        </button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.el-card {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  margin-bottom: var(--sp-3);
}

.el-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-2);
}

.el-kicker {
  color: var(--amber);
}

.el-server {
  font-size: var(--fs-meta);
  color: var(--text-strong);
}

.el-title {
  font-size: var(--fs-body);
  font-weight: var(--w-em);
  color: var(--text-title);
  overflow-wrap: anywhere;
  line-height: 1.4;
}

.el-text {
  font-size: var(--fs-ui);
  line-height: 1.5;
  color: var(--text-body);
  overflow-wrap: anywhere;
  text-wrap: pretty;
}

.el-meta {
  font-size: var(--fs-meta);
  line-height: 1.4;
  color: var(--text-meta);
  overflow-wrap: anywhere;
}

.el-intent {
  color: var(--text-mid);
}

.el-bad {
  font-size: var(--fs-meta);
  line-height: 1.4;
  color: var(--red);
  overflow-wrap: anywhere;
}

.el-form {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}

.el-field {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}

.el-label {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  font-size: var(--fs-meta);
  color: var(--text-mid);
}

.el-label input,
.el-label select {
  width: 100%;
  font-size: var(--fs-ui);
}

.el-check {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-ui);
  color: var(--text-body);
  cursor: pointer;
}

.el-label-text {
  color: var(--text-mid);
}

.el-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2);
  margin-top: var(--sp-1);
}
</style>
