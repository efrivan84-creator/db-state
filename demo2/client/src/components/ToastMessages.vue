<script setup>
defineProps({
  error: { type: String, default: "" },
  notice: { type: String, default: "" }
})
</script>

<template>
  <div class="pointer-events-none fixed bottom-4 right-4 z-10 w-[min(420px,calc(100vw-32px))] space-y-2">
    <p v-if="notice" class="rounded border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 shadow-sm">{{ notice }}</p>
    <p v-if="error" class="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 shadow-sm">{{ error }}</p>
  </div>
</template>
