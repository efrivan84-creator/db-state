<script setup>
defineProps({
  active: { type: Object, required: true },
  columns: { type: Array, required: true },
  currentIds: { type: Array, required: true },
  rows: { type: Array, required: true },
  selected: { type: Object, required: true },
  tableErrors: { type: Object, required: true }
})

defineEmits(["refresh-table", "select-row"])

function value(row, key) {
  let cursor = row
  for (const part of String(key).split(".")) {
    cursor = cursor?.[part]
  }
  if (Array.isArray(cursor)) return cursor.join(", ")
  if (typeof cursor === "boolean") return cursor ? "да" : "нет"
  if (cursor && typeof cursor === "object") return JSON.stringify(cursor)
  return cursor ?? ""
}
</script>

<template>
  <section class="overflow-hidden rounded border border-gray-200 bg-white shadow-sm">
    <div class="flex items-center justify-between border-b border-gray-200 px-4 py-3">
      <div>
        <h2 class="font-semibold">{{ active.label }}</h2>
        <p class="text-xs text-gray-500">{{ active.table }}</p>
      </div>
      <button class="h-9 rounded border border-gray-300 px-3 text-sm font-medium hover:bg-gray-50" @click="$emit('refresh-table', active.table)">
        Обновить
      </button>
    </div>

    <p v-if="tableErrors[active.table]" class="m-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{{ tableErrors[active.table] }}</p>
    <div v-else class="max-h-[680px] overflow-auto">
      <table class="w-full min-w-[720px] border-collapse text-sm">
        <thead class="sticky top-0 z-10 bg-gray-50 text-left text-xs uppercase tracking-normal text-gray-500">
          <tr>
            <th v-for="column in columns" :key="column.key" class="border-b border-gray-200 px-3 py-3 font-semibold">{{ column.label }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in rows"
            :key="row._id"
            class="cursor-pointer border-b border-gray-100 hover:bg-gray-50"
            :class="selected[active.table] === row._id ? 'bg-gray-100' : ''"
            @click="$emit('select-row', active.table, row._id)"
          >
            <td v-for="column in columns" :key="column.key" class="max-w-48 truncate px-3 py-3 text-gray-800">
              <span v-if="column.key === 'status'" class="rounded bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700">{{ value(row, column.key) }}</span>
              <span v-else>{{ value(row, column.key) }}</span>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="!currentIds.length" class="px-3 py-8 text-center text-sm text-gray-500">Нет доступных записей</p>
    </div>
  </section>
</template>
