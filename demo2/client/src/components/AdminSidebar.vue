<script setup>
defineProps({
  tabs: { type: Array, required: true }
})

const activeTab = defineModel("activeTab", { type: String, required: true })
const emit = defineEmits(["select-tab"])
</script>

<template>
  <nav class="space-y-1">
    <button
      v-for="tab in tabs"
      :key="tab.id"
      class="w-full rounded px-3 py-3 text-left transition"
      :class="activeTab === tab.id ? 'bg-white text-gray-950 shadow-sm' : 'text-gray-300 hover:bg-white/10 hover:text-white'"
      @click="activeTab = tab.id; emit('select-tab', tab)"
    >
      <span class="block text-sm font-semibold">{{ tab.label }}</span>
      <span class="mt-1 block text-xs" :class="activeTab === tab.id ? 'text-gray-500' : 'text-gray-500'">{{ tab.hint }}</span>
    </button>
  </nav>
</template>
