<script setup>
import { computed, ref, watch } from "vue"

import { state } from "./state.js"

const login = ref("manager")
const password = ref("manager")
const status = ref("open")
const comment = ref("Visible note")
const error = ref("")
const info = ref("")
const loading = state.getKeyRef("order-card")
const order = computed(() => state.order.load("o1", "order-card"))
const orderJson = computed(() => JSON.stringify(order.value, null, 2))
const loadingPercent = computed(() => Math.round(loading.percent))
const hasLoadedOrder = computed(() => order.value.__loaded === true)

watch(
  () => [order.value.status, order.value.comment, order.value.__loaded],
  ([nextStatus, nextComment, loaded]) => {
    if (!loaded) return
    status.value = nextStatus ?? ""
    comment.value = nextComment ?? ""
  },
  { immediate: true }
)

async function signIn() {
  error.value = ""
  info.value = ""

  try {
    await state.login(login.value, password.value)
    info.value = "Logged in. Reactive load will refresh order o1."
  } catch (err) {
    error.value = err.message
  }
}

async function saveAllowed() {
  error.value = ""
  info.value = ""

  try {
    await state.order.update({
      id: "o1",
      objedit: {
        status: status.value,
        comment: comment.value
      }
    }, "order-card")
    info.value = "Allowed fields saved"
  } catch (err) {
    error.value = err.message
  }
}

async function saveForbidden() {
  error.value = ""
  info.value = ""

  try {
    await state.order.update({
      id: "o1",
      objedit: {
        margin: 999
      }
    }, "order-card")
    info.value = "Margin saved"
  } catch (err) {
    error.value = err.message
  }
}
</script>

<template>
  <main class="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-5 px-4 py-6">
    <header class="flex flex-wrap items-end justify-between gap-3 border-b border-gray-200 pb-4">
      <div>
        <h1 class="text-2xl font-semibold tracking-normal text-gray-950">db-state demo</h1>
        <p class="mt-1 text-sm text-gray-600">Vue client, WebSocket server, auth, permissions, reactive load, field sync.</p>
      </div>
      <div class="text-right text-sm text-gray-600">
        <div>Socket: {{ state.sync.connected ? "connected" : "offline" }}</div>
        <div>Auth: {{ state.auth.status }}</div>
      </div>
    </header>

    <section class="grid gap-4 md:grid-cols-[320px_1fr]">
      <form class="rounded border border-gray-200 bg-white p-4 shadow-sm" @submit.prevent="signIn">
        <h2 class="text-base font-semibold text-gray-950">Login</h2>
        <label class="mt-4 block text-sm font-medium text-gray-700">
          User
          <select v-model="login" class="mt-1 w-full rounded border border-gray-300 bg-white px-3 py-2">
            <option value="manager">manager</option>
            <option value="admin">admin</option>
          </select>
        </label>
        <label class="mt-3 block text-sm font-medium text-gray-700">
          Password
          <input v-model="password" class="mt-1 w-full rounded border border-gray-300 px-3 py-2" type="password" />
        </label>
        <button class="mt-4 w-full rounded bg-gray-950 px-3 py-2 text-sm font-medium text-white hover:bg-gray-800">
          Login
        </button>
        <p class="mt-3 text-xs text-gray-500">Try manager/manager first. Field margin is hidden and write-protected.</p>
      </form>

      <section class="rounded border border-gray-200 bg-white p-4 shadow-sm">
        <div class="flex items-center justify-between gap-3">
          <h2 class="text-base font-semibold text-gray-950">Order o1</h2>
          <span class="rounded bg-gray-100 px-2 py-1 text-xs text-gray-600">
            key: {{ loading.value }}/{{ loading.max }} · {{ loadingPercent }}%
          </span>
        </div>

        <div v-if="!hasLoadedOrder" class="mt-4 h-28 animate-pulse rounded bg-gray-100"></div>

        <div v-else class="mt-4 grid gap-4 md:grid-cols-2">
          <div class="space-y-3">
            <label class="block text-sm font-medium text-gray-700">
              Status
              <input v-model="status" class="mt-1 w-full rounded border border-gray-300 px-3 py-2" />
            </label>
            <label class="block text-sm font-medium text-gray-700">
              Comment
              <textarea v-model="comment" class="mt-1 min-h-24 w-full rounded border border-gray-300 px-3 py-2"></textarea>
            </label>
            <div class="flex flex-wrap gap-2">
              <button type="button" class="rounded bg-emerald-700 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-800" @click="saveAllowed">
                Save allowed fields
              </button>
              <button type="button" class="rounded border border-red-300 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50" @click="saveForbidden">
                Try margin update
              </button>
            </div>
          </div>

          <pre class="overflow-auto rounded bg-gray-950 p-3 text-xs text-gray-100">{{ orderJson }}</pre>
        </div>

        <p v-if="hasLoadedOrder && loading.value > 0" class="mt-4 rounded border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800">
          Active operations for order-card: {{ loading.value }}
        </p>
        <p v-if="info" class="mt-4 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{{ info }}</p>
        <p v-if="error" class="mt-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{{ error }}</p>
      </section>
    </section>
  </main>
</template>
