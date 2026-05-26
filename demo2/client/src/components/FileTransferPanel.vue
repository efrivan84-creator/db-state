<script setup>
import { computed, ref } from "vue"

defineProps({
  loading: { type: Object, required: true },
  policy: { type: String, required: true },
  policyOptions: { type: Array, required: true },
  selectedFile: { type: Object, default: undefined },
  selectedFileUrl: { type: String, default: "" }
})

const policy = defineModel("policy", { type: String, required: true })
const emit = defineEmits(["upload", "download"])
const inputRef = ref(null)
const pickedFile = ref(null)
const copyStatus = ref("")
const pickedFileLabel = computed(() => pickedFile.value ? `${pickedFile.value.name} · ${formatSize(pickedFile.value.size)}` : "Файл не выбран")

function onPick(event) {
  pickedFile.value = event.target.files?.[0] ?? null
}

function upload() {
  if (!pickedFile.value) return
  emit("upload", pickedFile.value, policy.value)
  pickedFile.value = null
  if (inputRef.value) inputRef.value.value = ""
}

async function copyText(value, label) {
  if (!value) return
  await navigator.clipboard?.writeText(value)
  copyStatus.value = `${label} скопирован`
  setTimeout(() => {
    copyStatus.value = ""
  }, 1500)
}

function formatSize(size) {
  if (!Number.isFinite(size)) return ""
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}
</script>

<template>
  <section class="overflow-hidden rounded border border-gray-200 bg-white shadow-sm">
    <div class="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 px-4 py-3">
      <div>
        <h2 class="font-semibold">Файловый API</h2>
        <p class="text-xs text-gray-500">upload/download через тот же WebSocket, metadata в state.file</p>
      </div>
      <div class="text-right text-xs text-gray-500">
        <div>{{ loading.active ? `${loading.mode}: ${loading.percent}%` : "idle" }}</div>
        <div v-if="loading.active">{{ loading.loaded }} / {{ loading.total }} bytes</div>
      </div>
    </div>

    <div class="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div class="grid gap-3 md:grid-cols-[minmax(0,1fr)_220px_auto]">
        <label class="text-sm font-medium text-gray-700">
          Файл
          <input ref="inputRef" class="mt-1 block w-full rounded border border-gray-300 px-3 py-2 text-sm" type="file" @change="onPick" />
          <span class="mt-1 block truncate text-xs text-gray-500">{{ pickedFileLabel }}</span>
        </label>

        <label class="text-sm font-medium text-gray-700">
          Политика скачивания
          <select v-model="policy" class="mt-1 block h-10 w-full rounded border border-gray-300 bg-white px-3 text-sm">
            <option v-for="item in policyOptions" :key="item.value" :value="item.value">{{ item.label }}</option>
          </select>
        </label>

        <button
          class="mt-6 h-10 rounded bg-gray-950 px-4 text-sm font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="!pickedFile || loading.active"
          @click="upload"
        >
          Загрузить
        </button>
      </div>

      <aside class="rounded border border-gray-200 bg-gray-50 p-3">
        <h3 class="text-sm font-semibold text-gray-800">Выбранный файл</h3>
        <dl class="mt-2 space-y-1 text-xs text-gray-600">
          <div class="flex justify-between gap-3">
            <dt>Имя</dt>
            <dd class="truncate text-right text-gray-900">{{ selectedFile?.name || "не выбран" }}</dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt>Размер</dt>
            <dd class="text-gray-900">{{ selectedFile ? formatSize(selectedFile.size) : "" }}</dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt>Статус</dt>
            <dd class="text-gray-900">{{ selectedFile?.status || "" }}</dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt>Доступ</dt>
            <dd class="text-gray-900">{{ selectedFile?.downloadPolicy?.mode || "" }}</dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt>URL</dt>
            <dd class="max-w-52 truncate text-right font-mono text-gray-900">{{ selectedFileUrl }}</dd>
          </div>
        </dl>
        <div class="mt-3 grid gap-2">
          <button
            class="h-9 w-full rounded border border-gray-300 bg-white text-sm font-medium text-gray-800 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="!selectedFile?.token || loading.active"
            @click="emit('download')"
          >
            Скачать выбранный
          </button>
          <div class="grid grid-cols-2 gap-2">
            <button
              class="h-9 rounded border border-gray-300 bg-white text-xs font-medium text-gray-800 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="!selectedFile?.token"
              @click="copyText(selectedFile.token, 'Token')"
            >
              Token
            </button>
            <button
              class="h-9 rounded border border-gray-300 bg-white text-xs font-medium text-gray-800 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="!selectedFileUrl"
              @click="copyText(selectedFileUrl, 'URL')"
            >
              URL
            </button>
          </div>
          <p v-if="copyStatus" class="text-xs text-emerald-700">{{ copyStatus }}</p>
        </div>
      </aside>
    </div>
  </section>
</template>
