<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from "vue"

const props = defineProps({
  active: { type: Object, required: true },
  config: { type: Object, required: true },
  fields: { type: Array, required: true },
  drafts: { type: Object, required: true },
  selected: { type: Object, required: true },
  visibleDocJson: { type: String, required: true }
})

const emit = defineEmits(["save", "add", "delete"])

const confirmingDelete = ref(false)
const deleteRootRef = ref(null)

watch(() => props.active.table, () => {
  confirmingDelete.value = false
})

function requestDelete() {
  confirmingDelete.value = true
}

function cancelDelete() {
  confirmingDelete.value = false
}

function confirmDelete() {
  emit("delete", props.active.table)
  confirmingDelete.value = false
}

function onClickOutside(event) {
  if (!confirmingDelete.value) return
  if (deleteRootRef.value && !deleteRootRef.value.contains(event.target)) {
    confirmingDelete.value = false
  }
}

function onEscape(event) {
  if (event.key === "Escape") confirmingDelete.value = false
}

onMounted(() => {
  document.addEventListener("mousedown", onClickOutside)
  document.addEventListener("keydown", onEscape)
})

onBeforeUnmount(() => {
  document.removeEventListener("mousedown", onClickOutside)
  document.removeEventListener("keydown", onEscape)
})
</script>

<template>
  <section class="overflow-hidden rounded border border-gray-200 bg-white shadow-sm">
    <div class="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 px-4 py-3">
      <div>
        <h2 class="font-semibold">Редактор</h2>
        <p class="text-xs text-gray-500">Выбранная запись: {{ selected[active.table] || "не выбрана" }}</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <button class="h-9 rounded bg-gray-950 px-3 text-sm font-medium text-white hover:bg-gray-800" @click="$emit('add', active.table)">Добавить</button>
        <button class="h-9 rounded bg-emerald-700 px-3 text-sm font-medium text-white hover:bg-emerald-800" @click="$emit('save', active.table)">
          {{ config.rawJson ? "Сохранить JSON" : "Сохранить" }}
        </button>
        <div ref="deleteRootRef" class="relative">
          <button
            class="h-9 rounded border border-red-300 px-3 text-sm font-medium text-red-700 hover:bg-red-50"
            :disabled="!selected[active.table]"
            :class="{ 'opacity-50 cursor-not-allowed': !selected[active.table] }"
            @click="requestDelete"
          >
            Удалить
          </button>
          <div
            v-if="confirmingDelete"
            class="absolute right-0 z-20 mt-2 w-64 rounded-lg border border-gray-200 bg-white p-3 shadow-lg"
          >
            <p class="text-sm text-gray-800">
              Точно удалить запись
              <span class="font-mono text-xs text-gray-600">{{ selected[active.table] }}</span>?
            </p>
            <p class="mt-1 text-xs text-gray-500">Действие необратимо.</p>
            <div class="mt-3 flex justify-end gap-2">
              <button class="h-8 rounded border border-gray-300 px-3 text-xs font-medium text-gray-700 hover:bg-gray-50" @click="cancelDelete">Нет</button>
              <button class="h-8 rounded bg-red-600 px-3 text-xs font-medium text-white hover:bg-red-700" @click="confirmDelete">Да, удалить</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="grid gap-4 p-4 2xl:grid-cols-[minmax(0,1fr)_360px]">
      <div>
        <template v-if="config.rawJson">
          <textarea v-model="drafts[active.table]" class="min-h-[500px] w-full rounded border border-gray-300 bg-gray-950 px-4 py-3 font-mono text-xs text-gray-100"></textarea>
          <p class="mt-2 text-xs text-gray-500">Поле <code>_id</code> не редактируется здесь — оно присваивается автоматически при сохранении.</p>
        </template>

        <div v-else class="grid gap-3 md:grid-cols-2">
          <template v-for="field in fields" :key="field.key">
            <label
              v-if="field.type === 'textarea'"
              class="text-sm font-medium text-gray-700"
              :class="{ 'md:col-span-2': field.colSpan === 2 }"
            >
              {{ field.label }}
              <textarea
                v-model="drafts[active.table][field.key]"
                class="mt-1 min-h-28 w-full rounded border border-gray-300 px-3 py-2"
                :disabled="field.disabled"
              ></textarea>
            </label>

            <label
              v-else-if="field.type === 'checkbox'"
              class="flex items-center gap-2 text-sm font-medium text-gray-700"
            >
              <input v-model="drafts[active.table][field.key]" type="checkbox" :disabled="field.disabled" />
              {{ field.label }}
            </label>

            <label
              v-else-if="field.type === 'number'"
              class="text-sm font-medium text-gray-700"
              :class="{ 'md:col-span-2': field.colSpan === 2 }"
            >
              {{ field.label }}
              <input
                v-model.number="drafts[active.table][field.key]"
                type="number"
                class="mt-1 h-10 w-full rounded border px-3"
                :class="field.disabled ? 'border-gray-200 bg-gray-50' : 'border-gray-300'"
                :disabled="field.disabled"
              />
            </label>

            <label
              v-else
              class="text-sm font-medium text-gray-700"
              :class="{ 'md:col-span-2': field.colSpan === 2 }"
            >
              {{ field.label }}
              <input
                v-model="drafts[active.table][field.key]"
                type="text"
                class="mt-1 h-10 w-full rounded border px-3"
                :class="field.disabled ? 'border-gray-200 bg-gray-50' : 'border-gray-300'"
                :placeholder="field.placeholder"
                :disabled="field.disabled"
              />
            </label>
          </template>
        </div>
      </div>

      <aside class="space-y-3">
        <section class="rounded border border-gray-200 bg-gray-50 p-3">
          <h3 class="text-sm font-semibold text-gray-700">Видимая запись</h3>
          <pre class="mt-2 max-h-80 overflow-auto rounded bg-gray-950 p-3 text-xs text-gray-100">{{ visibleDocJson }}</pre>
        </section>
        <section class="rounded border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700">
          <h3 class="font-semibold text-gray-800">Проверка прав</h3>
          <p class="mt-2">Администратор работает со всеми служебными таблицами.</p>
          <p class="mt-2">Менеджер видит заказы без маржи и сохраняет только статус с комментарием.</p>
          <p class="mt-2">Наблюдатель читает сокращённый набор полей без права записи.</p>
        </section>
      </aside>
    </div>
  </section>
</template>
