<script setup>
import { computed, onMounted, ref, watch } from "vue"

import { state } from "./state.js"

const login = ref("manager")
const password = ref("manager")

// В demo пароль совпадает с логином — подставляем его при смене пользователя,
// чтобы выбор в списке не приводил к «Invalid login or password».
watch(login, (next) => {
  password.value = next
})
const error = ref("")
const info = ref("")
const journal = ref([])

// --- Реактивные запросы -----------------------------------------------------
// Все три создаются один раз и сами обновляются после каждой синхронизации.
const total = state.order.countRef({})
const ids = state.order.idsRef({ sort: { number: 1 } })
const orders = state.order.listRef({ sort: { number: 1 } }, "список")

// --- Реактивный документ ----------------------------------------------------
const selectedId = ref("o1")
const loading = state.getKeyRef("карточка")
const order = computed(() => state.order.load(selectedId.value || ids.value[0], "карточка"))
const orderJson = computed(() => JSON.stringify(order.value, null, 2))
const hasLoadedOrder = computed(() => order.value.__loaded === true)
const loadingPercent = computed(() => Math.round(loading.percent))

const status = ref("")
const comment = ref("")

// login, groups и access приходят от сервера при входе и лежат в state.auth.
const AUTH_LABELS = {
  anonymous: "не выполнена",
  authorizing: "выполняется…",
  restored: "восстановлена",
  authorized: "выполнена"
}

const ROLES = { admin: "руководитель", manager: "менеджер" }

const authLabel = computed(() => {
  const label = AUTH_LABELS[state.auth.status] ?? state.auth.status
  if (!state.auth.login) return label

  const role = state.auth.groups.map((group) => ROLES[group] ?? group).join(", ")
  return role ? `${state.auth.login} (${role})` : state.auth.login
})

watch(
  () => [order.value.status, order.value.comment, order.value.__loaded],
  ([nextStatus, nextComment, loaded]) => {
    if (!loaded) return
    status.value = nextStatus ?? ""
    comment.value = nextComment ?? ""
  },
  { immediate: true }
)

// --- Подписки на изменения --------------------------------------------------
onMounted(() => {
  // onAdd / onEdit получают (obj, change), onDelete — (oldObj, change).
  state.order.onAdd((obj) => note(`добавлен заказ №${obj?.number ?? "?"}`))
  state.order.onEdit((obj, change) => note(`изменён ${change.id}: ${Object.keys(change.set ?? {}).join(", ")}`))
  state.order.onDelete((oldObj, change) => note(`удалён заказ №${oldObj?.number ?? change.id}`))
})

function note(text) {
  journal.value = [`${new Date().toLocaleTimeString("ru-RU")} — ${text}`, ...journal.value].slice(0, 8)
}

// Сообщения библиотеки приходят по-английски — показываем их по-русски.
const MESSAGES = {
  "Invalid login or password": "Неверный логин или пароль",
  "Unauthorized": "Требуется авторизация",
  "Too many attempts": "Слишком много попыток"
}

function humanize(message) {
  if (MESSAGES[message]) return MESSAGES[message]
  const field = message.match(/^Write denied: field (.+)$/)
  if (field) return `Запись запрещена: поле «${field[1]}» вне ваших прав`
  if (message.startsWith("Write denied")) return "Запись запрещена: это чужой заказ"
  if (message.startsWith("Read denied")) return "Чтение запрещено правами группы"
  return message
}

async function run(action, okText) {
  error.value = ""
  info.value = ""

  try {
    const result = await action()
    info.value = typeof okText === "function" ? okText(result) : okText
  } catch (err) {
    error.value = humanize(err.message)
  }
}

// --- Авторизация ------------------------------------------------------------
const signIn = () => run(
  () => state.login(login.value, password.value),
  `Вход выполнен: ${login.value}. Реактивные запросы обновятся сами.`
)

const signOut = () => run(() => state.logout(), "Выход выполнен")

const clearCache = () => run(() => state.clearLocalDB(), "Локальный кэш очищен")

const syncNow = () => run(() => state.syncNow(), "Синхронизация выполнена")

// --- Разовые чтения ---------------------------------------------------------
const readIds = () => run(
  () => state.order.getIds({ sort: { number: 1 } }, "список"),
  (result) => `getIds вернул ${result.length}: ${result.join(", ")}`
)

const readUnique = () => run(
  () => state.order.getUnique({ field: "status" }, "список"),
  (result) => `getUnique по статусам: ${result.join(", ")}`
)

const readAsync = () => run(
  () => state.order.getAsync(selectedId.value, "карточка"),
  (result) => `getAsync: заказ №${result?.number ?? "?"}`
)

// --- Запись -----------------------------------------------------------------
const saveAllowed = () => run(
  () => state.order.update({ id: selectedId.value, set: { status: status.value, comment: comment.value } }, "карточка"),
  "Разрешённые поля сохранены"
)

const saveForbidden = () => run(
  () => state.order.update({ id: selectedId.value, set: { margin: 999 } }, "карточка"),
  "Маржа сохранена"
)

// Заказ o2 архивный: запрет приходит из хука beforeWrite вместе с причиной,
// а не из прав группы — у руководителя на order доступ полный.
const saveArchived = () => run(
  () => state.order.update({ id: "o2", set: { status: "новый" } }, "карточка"),
  "Архивный заказ сохранён"
)

const addOrder = () => run(async () => {
  // Именованный RPC-метод сервера рядом со стандартным CRUD.
  const { number } = await state.socket.rpc("order.next-number", {})
  // ownerId обязателен: право на запись у менеджера — { ownerId: "$adminid" },
  // и для add фильтр проверяется по новому документу.
  return state.order.add({
    number,
    status: "новый",
    client: "Новый клиент",
    total: 1000,
    comment: "",
    ownerId: state.auth.userId
  }, "список")
}, "Заказ создан")

const removeOrder = () => run(async () => {
  const id = selectedId.value
  if (!id) throw new Error("Сначала выберите заказ в списке")

  const result = await state.order.remove(id, "список")
  // После удаления возвращаемся на первый доступный заказ.
  selectedId.value = ids.value.find((item) => item !== id) ?? ""
  return result
}, "Заказ удалён")
</script>

<template>
  <main class="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-5 px-4 py-6">
    <header class="flex flex-wrap items-end justify-between gap-3 border-b border-gray-200 pb-4">
      <div>
        <h1 class="text-2xl font-semibold tracking-normal text-gray-950">db-state — демонстрация</h1>
        <p class="mt-1 text-sm text-gray-600">
          Vue-клиент, WebSocket-сервер, вход, права по группам, хуки, реактивные документы и списки, синхронизация.
        </p>
      </div>
      <div class="text-right text-sm text-gray-600">
        <div>Соединение: {{ state.sync.connected ? "есть" : "нет" }}</div>
        <div>Авторизация: {{ authLabel }}</div>
        <div>Синхронизация: {{ state.sync.status }}</div>
      </div>
    </header>

    <section class="grid gap-4 lg:grid-cols-[300px_1fr]">
      <div class="space-y-4">
        <form class="rounded border border-gray-200 bg-white p-4 shadow-sm" @submit.prevent="signIn">
          <h2 class="text-base font-semibold text-gray-950">Вход</h2>
          <label class="mt-4 block text-sm font-medium text-gray-700">
            Пользователь
            <select v-model="login" class="mt-1 w-full rounded border border-gray-300 bg-white px-3 py-2">
              <option value="manager">manager</option>
              <option value="admin">admin</option>
            </select>
          </label>
          <label class="mt-3 block text-sm font-medium text-gray-700">
            Пароль
            <input v-model="password" class="mt-1 w-full rounded border border-gray-300 px-3 py-2" type="password" />
          </label>
          <button class="mt-4 w-full rounded bg-gray-950 px-3 py-2 text-sm font-medium text-white hover:bg-gray-800">
            Войти
          </button>
          <p class="mt-3 text-xs text-gray-500">
            Пароль совпадает с логином и подставляется сам при выборе пользователя.
            У менеджера поле «маржа» скрыто и защищено от записи.
          </p>
          <div class="mt-3 flex flex-wrap gap-2">
            <button type="button" class="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50" @click="signOut">
              Выйти
            </button>
            <button type="button" class="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50" @click="syncNow">
              Синхронизировать
            </button>
            <button type="button" class="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50" @click="clearCache">
              Очистить кэш
            </button>
          </div>
        </form>

        <section class="rounded border border-gray-200 bg-white p-4 shadow-sm">
          <h2 class="text-base font-semibold text-gray-950">Разовые чтения</h2>
          <p class="mt-1 text-xs text-gray-500">Без подписки: результат приходит один раз.</p>
          <div class="mt-3 flex flex-col gap-2">
            <button type="button" class="rounded border border-gray-300 px-3 py-2 text-sm text-gray-800 hover:bg-gray-50" @click="readIds">
              getIds — список id
            </button>
            <button type="button" class="rounded border border-gray-300 px-3 py-2 text-sm text-gray-800 hover:bg-gray-50" @click="readUnique">
              getUnique — статусы
            </button>
            <button type="button" class="rounded border border-gray-300 px-3 py-2 text-sm text-gray-800 hover:bg-gray-50" @click="readAsync">
              getAsync — один документ
            </button>
          </div>
        </section>

        <section class="rounded border border-gray-200 bg-white p-4 shadow-sm">
          <h2 class="text-base font-semibold text-gray-950">Журнал изменений</h2>
          <p class="mt-1 text-xs text-gray-500">Подписки onAdd / onEdit / onDelete.</p>
          <ul v-if="journal.length" class="mt-3 space-y-1 text-xs text-gray-700">
            <li v-for="(row, index) in journal" :key="index" class="rounded bg-gray-50 px-2 py-1">{{ row }}</li>
          </ul>
          <p v-else class="mt-3 text-xs text-gray-400">Пока пусто — измените заказ.</p>
        </section>
      </div>

      <div class="space-y-4">
        <section class="rounded border border-gray-200 bg-white p-4 shadow-sm">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <h2 class="text-base font-semibold text-gray-950">
              Заказы
              <span class="ml-2 rounded bg-gray-100 px-2 py-1 text-xs font-normal text-gray-600">
                countRef: {{ total }} · idsRef: {{ ids.length }}
              </span>
            </h2>
            <button type="button" class="rounded bg-gray-950 px-3 py-2 text-sm font-medium text-white hover:bg-gray-800" @click="addOrder">
              Создать заказ
            </button>
          </div>
          <p class="mt-1 text-xs text-gray-500">
            listRef: список сам перечитывается после любой записи. Номер выдаёт свой RPC-метод order.next-number.
            Менеджер видит все заказы, но правит и удаляет только свои — право на запись у него
            ограничено фильтром { ownerId: "$adminid" }, и этот фильтр уходит прямо в запрос к базе.
          </p>

          <table class="mt-3 w-full text-left text-sm">
            <thead class="text-xs uppercase text-gray-500">
              <tr>
                <th class="py-2">Номер</th>
                <th class="py-2">Клиент</th>
                <th class="py-2">Статус</th>
                <th class="py-2 text-right">Сумма</th>
                <th class="py-2 pr-6 text-right">Маржа</th>
                <th class="py-2">Владелец</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in orders"
                :key="row._id"
                class="cursor-pointer border-t border-gray-100 hover:bg-gray-50"
                :class="row._id === selectedId ? 'bg-gray-50' : ''"
                @click="selectedId = row._id"
              >
                <td class="py-2">{{ row.number ?? "…" }}</td>
                <td class="py-2">{{ row.client ?? "…" }}</td>
                <td class="py-2">{{ row.status ?? "…" }}</td>
                <td class="py-2 text-right">{{ row.total ?? "…" }}</td>
                <td class="py-2 pr-6 text-right" :class="row.margin === undefined ? 'text-gray-300' : ''">
                  {{ row.margin ?? "—" }}
                </td>
                <td class="py-2 text-xs" :class="row.ownerId === state.auth.userId ? 'text-emerald-700' : 'text-gray-500'">
                  {{ row.ownerId === state.auth.userId ? "мой" : "чужой" }}
                </td>
              </tr>
            </tbody>
          </table>
        </section>

        <section class="rounded border border-gray-200 bg-white p-4 shadow-sm">
          <div class="flex items-center justify-between gap-3">
            <h2 class="text-base font-semibold text-gray-950">Карточка заказа {{ selectedId }}</h2>
            <span class="rounded bg-gray-100 px-2 py-1 text-xs text-gray-600">
              прогресс: {{ loading.value }}/{{ loading.max }} · {{ loadingPercent }}%
            </span>
          </div>

          <div v-if="!hasLoadedOrder" class="mt-4 h-28 animate-pulse rounded bg-gray-100"></div>

          <div v-else class="mt-4 grid gap-4 md:grid-cols-2">
            <div class="space-y-3">
              <label class="block text-sm font-medium text-gray-700">
                Статус
                <input v-model="status" class="mt-1 w-full rounded border border-gray-300 px-3 py-2" />
              </label>
              <label class="block text-sm font-medium text-gray-700">
                Комментарий
                <textarea v-model="comment" class="mt-1 min-h-20 w-full rounded border border-gray-300 px-3 py-2"></textarea>
              </label>
              <div class="flex flex-wrap gap-2">
                <button type="button" class="rounded bg-emerald-700 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-800" @click="saveAllowed">
                  Сохранить
                </button>
                <button type="button" class="rounded border border-red-300 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50" @click="saveForbidden">
                  Записать маржу
                </button>
                <button type="button" class="rounded border border-amber-300 px-3 py-2 text-sm font-medium text-amber-700 hover:bg-amber-50" @click="saveArchived">
                  Изменить архивный
                </button>
                <button type="button" class="rounded border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50" @click="removeOrder">
                  Удалить
                </button>
              </div>
              <p class="text-xs text-gray-500">
                «Записать маржу» — отказ по правам группы (write_fields).
                «Изменить архивный» — отказ из хука beforeWrite со своей причиной,
                он действует даже для руководителя.
                Статус приводится к нижнему регистру хуком до записи.
              </p>
            </div>

            <pre class="overflow-auto rounded bg-gray-950 p-3 text-xs text-gray-100">{{ orderJson }}</pre>
          </div>

          <p v-if="info" class="mt-4 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{{ info }}</p>
          <p v-if="error" class="mt-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{{ error }}</p>
        </section>
      </div>
    </section>
  </main>
</template>
