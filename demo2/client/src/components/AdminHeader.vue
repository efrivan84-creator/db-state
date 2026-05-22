<script setup>
defineProps({
  accounts: { type: Array, required: true },
  authStatus: { type: String, required: true },
  accountLabel: { type: String, required: true }
})

const login = defineModel("login", { type: String, required: true })
const password = defineModel("password", { type: String, required: true })
const emit = defineEmits(["sign-in", "sign-out"])
</script>

<template>
  <header class="border-b border-gray-200 bg-white">
    <div class="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
      <div>
        <p class="text-xs font-semibold uppercase tracking-normal text-gray-500">Панель управления</p>
        <h1 class="mt-1 text-xl font-semibold">Администрирование данных</h1>
      </div>

      <div v-if="authStatus === 'authorized' || authStatus === 'restored'" class="flex flex-wrap items-center gap-3">
        <div class="text-right">
          <p class="text-xs font-medium text-gray-500">Вход выполнен</p>
          <p class="text-sm font-semibold text-gray-950">{{ accountLabel }}</p>
        </div>
        <button class="h-10 rounded border border-gray-300 px-4 text-sm font-medium text-gray-800 hover:bg-gray-50" @click="emit('sign-out')">
          Выйти
        </button>
      </div>

      <form v-else class="flex flex-wrap items-end gap-2" @submit.prevent="emit('sign-in')">
        <label class="text-xs font-medium text-gray-600">
          Учетная запись
          <select v-model="login" class="mt-1 block h-10 w-40 rounded border border-gray-300 bg-white px-3 text-sm">
            <option v-for="account in accounts" :key="account.login" :value="account.login">{{ account.label }}</option>
          </select>
        </label>
        <label class="text-xs font-medium text-gray-600">
          Пароль
          <input v-model="password" class="mt-1 block h-10 w-40 rounded border border-gray-300 px-3 text-sm" type="password" />
        </label>
        <button class="h-10 rounded bg-gray-950 px-4 text-sm font-medium text-white hover:bg-gray-800">Войти</button>
      </form>
    </div>
  </header>
</template>
