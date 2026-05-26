<script setup>
defineProps({
  active: { type: Object, required: true },
  columns: { type: Array, required: true },
  currentIds: { type: Array, required: true },
  pageCount: { type: Number, required: true },
  pageEnd: { type: Number, required: true },
  pageStart: { type: Number, required: true },
  queryConfig: { type: Object, required: true },
  queryControl: { type: Object, required: true },
  rows: { type: Array, required: true },
  selected: { type: Object, required: true },
  tableErrors: { type: Object, required: true },
  totalCount: { type: Number, required: true }
})

defineEmits(["refresh-table", "select-row", "set-filter", "set-page", "set-page-size", "set-search", "set-sort"])

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

function optionLabel(option) {
  return typeof option === "object" ? option.label : option
}

function optionValue(option) {
  return typeof option === "object" ? option.value : option
}

function encodeValue(value) {
  return JSON.stringify(value)
}

function decodeValue(value) {
  return JSON.parse(value)
}
</script>

<template>
  <section class="overflow-hidden rounded border border-gray-200 bg-white shadow-sm">
    <div class="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 px-4 py-3">
      <div>
        <h2 class="font-semibold">{{ active.label }}</h2>
        <p class="text-xs text-gray-500">{{ active.table }} · {{ totalCount }} записей</p>
      </div>
      <button class="h-9 rounded border border-gray-300 px-3 text-sm font-medium hover:bg-gray-50" @click="$emit('refresh-table', active.table)">
        Обновить
      </button>
    </div>

    <div class="grid gap-3 border-b border-gray-200 bg-gray-50 px-4 py-3 md:grid-cols-[minmax(0,1fr)_auto_auto]">
      <label class="text-xs font-medium uppercase tracking-normal text-gray-500">
        Поиск
        <input
          class="mt-1 h-9 w-full rounded border border-gray-300 bg-white px-3 text-sm font-normal normal-case text-gray-900"
          :placeholder="queryConfig.searchPlaceholder || 'Поиск'"
          :value="queryControl.search"
          @input="$emit('set-search', $event.target.value)"
        />
      </label>

      <div class="flex flex-wrap gap-2">
        <label v-for="filter in queryConfig.filters || []" :key="filter.key" class="text-xs font-medium uppercase tracking-normal text-gray-500">
          {{ filter.label }}
          <select
            class="mt-1 h-9 min-w-40 rounded border border-gray-300 bg-white px-3 text-sm font-normal normal-case text-gray-900"
            :value="encodeValue(queryControl.filters[filter.key])"
            @change="$emit('set-filter', filter.key, decodeValue($event.target.value))"
          >
            <option :value="encodeValue('')">{{ filter.all || 'Все' }}</option>
            <option v-for="option in filter.options" :key="encodeValue(optionValue(option))" :value="encodeValue(optionValue(option))">
              {{ optionLabel(option) }}
            </option>
          </select>
        </label>
      </div>

      <div class="flex flex-wrap gap-2">
        <label class="text-xs font-medium uppercase tracking-normal text-gray-500">
          Сортировка
          <select
            class="mt-1 h-9 min-w-40 rounded border border-gray-300 bg-white px-3 text-sm font-normal normal-case text-gray-900"
            :value="queryControl.sort"
            @change="$emit('set-sort', $event.target.value)"
          >
            <option v-for="item in queryConfig.sort || []" :key="item.value" :value="item.value">{{ item.label }}</option>
          </select>
        </label>

        <label class="text-xs font-medium uppercase tracking-normal text-gray-500">
          На странице
          <select
            class="mt-1 h-9 rounded border border-gray-300 bg-white px-3 text-sm font-normal normal-case text-gray-900"
            :value="queryControl.pageSize"
            @change="$emit('set-page-size', Number($event.target.value))"
          >
            <option v-for="size in queryConfig.pageSizes || [10]" :key="size" :value="size">{{ size }}</option>
          </select>
        </label>
      </div>
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

    <div class="flex flex-wrap items-center justify-between gap-3 border-t border-gray-200 px-4 py-3 text-sm text-gray-600">
      <div>{{ pageStart }}-{{ pageEnd }} из {{ totalCount }}</div>
      <div class="flex items-center gap-2">
        <button class="h-8 rounded border border-gray-300 px-3 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50" :disabled="queryControl.page === 0" @click="$emit('set-page', -1)">
          Назад
        </button>
        <span class="min-w-24 text-center">стр. {{ queryControl.page + 1 }} / {{ pageCount }}</span>
        <button class="h-8 rounded border border-gray-300 px-3 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50" :disabled="queryControl.page + 1 >= pageCount" @click="$emit('set-page', 1)">
          Вперед
        </button>
      </div>
    </div>
  </section>
</template>
