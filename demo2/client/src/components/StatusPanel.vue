<script setup>
defineProps({
  authText: { type: String, required: true },
  connectionText: { type: String, required: true },
  connected: { type: Boolean, required: true },
  loading: { type: Number, required: true },
  stats: { type: Object, required: true },
  syncText: { type: String, required: true }
})

defineEmits(["refresh-all"])
</script>

<template>
  <section class="rounded border border-white/10 bg-white/5 p-3">
    <div class="grid grid-cols-2 gap-2 text-sm">
      <div class="rounded bg-black/20 p-2">
        <div class="text-xs text-gray-400">Сокет</div>
        <div class="mt-1 font-semibold" :class="connected ? 'text-emerald-300' : 'text-red-300'">{{ connectionText }}</div>
      </div>
      <div class="rounded bg-black/20 p-2">
        <div class="text-xs text-gray-400">Вход</div>
        <div class="mt-1 font-semibold text-white">{{ authText }}</div>
      </div>
      <div class="rounded bg-black/20 p-2">
        <div class="text-xs text-gray-400">Sync</div>
        <div class="mt-1 font-semibold text-white">{{ syncText }}</div>
      </div>
      <div class="rounded bg-black/20 p-2">
        <div class="text-xs text-gray-400">Загрузка</div>
        <div class="mt-1 font-semibold text-white">{{ loading }}</div>
      </div>
    </div>
  </section>

  <section class="rounded border border-white/10 bg-white/5 p-3 text-sm text-gray-200">
    <h2 class="font-semibold text-white">Записи</h2>
    <dl class="mt-3 grid grid-cols-2 gap-2">
      <div><dt class="text-xs text-gray-500">Заказы</dt><dd class="font-semibold text-white">{{ stats.orders }}</dd></div>
      <div><dt class="text-xs text-gray-500">Пользователи</dt><dd class="font-semibold text-white">{{ stats.users }}</dd></div>
      <div><dt class="text-xs text-gray-500">Группы</dt><dd class="font-semibold text-white">{{ stats.groups }}</dd></div>
      <div><dt class="text-xs text-gray-500">Права</dt><dd class="font-semibold text-white">{{ stats.permissions }}</dd></div>
    </dl>
    <button class="mt-3 h-9 w-full rounded border border-white/15 text-sm font-medium text-white hover:bg-white/10" @click="$emit('refresh-all')">
      Обновить все
    </button>
  </section>
</template>
