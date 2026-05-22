<script setup>
import { computed, ref } from "vue"

import { state } from "./state.js"

const login = ref("manager")
const password = ref("manager")
const status = ref("open")
const comment = ref("Visible note")
const error = ref("")
const info = ref("")
const loading = state.getKeyRef("order-card")
const order = computed(() => state.order.load("o1", "order-card"))

async function signIn() {
  error.value = ""
  info.value = ""

  try {
    await state.login(login.value, password.value)
    await state.syncNow()
    const fresh = await state.order.getAsync("o1", "order-card")
    status.value = fresh?.status ?? ""
    comment.value = fresh?.comment ?? ""
    info.value = "Logged in and loaded order o1"
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
    })
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
    })
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
        <p class="mt-1 text-sm text-gray-600">Vue client, WebSocket server, auth, permissions, field sync.</p>
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
          <span class="rounded bg-gray-100 px-2 py-1 text-xs text-gray-600">loading key: {{ loading }}</span>
        </div>

        <div v-if="loading > 0" class="mt-4 h-28 animate-pulse rounded bg-gray-100"></div>

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

          <pre class="overflow-auto rounded bg-gray-950 p-3 text-xs text-gray-100">{{ JSON.stringify(order, null, 2) }}</pre>
        </div>

        <p v-if="info" class="mt-4 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{{ info }}</p>
        <p v-if="error" class="mt-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{{ error }}</p>
      </section>
    </section>
  </main>
</template>
