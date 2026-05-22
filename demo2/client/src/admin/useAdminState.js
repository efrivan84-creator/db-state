import { computed, reactive, ref, watch, watchEffect } from "vue"

import { state } from "../state.js"

const tabs = [
  { id: "orders", label: "Заказы", table: "order", hint: "Операции, суммы, маржа и ответственные" },
  { id: "users", label: "Пользователи", table: "_user", hint: "Логины, группы и блокировка доступа" },
  { id: "groups", label: "Группы", table: "_group", hint: "Группы клиентов без ролей" },
  { id: "permissions", label: "Права", table: "_permission", hint: "Правила чтения, записи, условий и полей" }
]

const accounts = [
  { login: "admin", label: "Администратор" },
  { login: "manager", label: "Менеджер" },
  { login: "viewer", label: "Наблюдатель" }
]

const tableConfigs = {
  order: {
    idPrefix: "o",
    columns: [
      { key: "_id", label: "ID" },
      { key: "status", label: "Статус" },
      { key: "total", label: "Сумма" },
      { key: "margin", label: "Маржа" },
      { key: "ownerId", label: "Ответственный" }
    ],
    fields: [
      { key: "_id", label: "ID", type: "text", disabled: true },
      { key: "status", label: "Статус", type: "text" },
      { key: "total", label: "Сумма", type: "number" },
      { key: "margin", label: "Маржа", type: "number" },
      { key: "ownerId", label: "Ответственный", type: "text" },
      { key: "comment", label: "Комментарий", type: "textarea", colSpan: 2 }
    ],
    emptyDraft: () => ({ _id: "", status: "", total: 0, margin: 0, comment: "", ownerId: "" }),
    fromDoc: (doc) => ({
      _id: doc?._id ?? "",
      status: doc?.status ?? "",
      total: doc?.total ?? 0,
      margin: doc?.margin ?? 0,
      comment: doc?.comment ?? "",
      ownerId: doc?.ownerId ?? ""
    }),
    toPatch: (draft) => ({
      status: draft.status,
      total: Number(draft.total),
      margin: Number(draft.margin),
      comment: draft.comment,
      ownerId: draft.ownerId
    }),
    buildNewDoc: (id) => ({
      _id: id,
      status: "open",
      total: 0,
      margin: 0,
      comment: "",
      ownerId: state.auth.userId
    }),
    notices: { saved: "Заказ сохранён", added: "Заказ добавлен", removed: "Заказ удалён" }
  },

  _user: {
    idPrefix: "u_",
    columns: [
      { key: "_id", label: "ID" },
      { key: "login", label: "Логин" },
      { key: "groups", label: "Группы" },
      { key: "disabled", label: "Блокировка" }
    ],
    fields: [
      { key: "_id", label: "ID", type: "text", disabled: true },
      { key: "login", label: "Логин", type: "text" },
      { key: "password", label: "Новый пароль", type: "text", placeholder: "не менять" },
      { key: "groups", label: "Группы через запятую", type: "text" },
      { key: "disabled", label: "Заблокирован", type: "checkbox" }
    ],
    emptyDraft: () => ({ _id: "", login: "", password: "", groups: "", disabled: false }),
    fromDoc: (doc) => ({
      _id: doc?._id ?? "",
      login: doc?.login ?? "",
      password: "",
      groups: (doc?.groups ?? []).join(", "),
      disabled: Boolean(doc?.disabled)
    }),
    toPatch: (draft) => {
      const set = {
        login: draft.login,
        groups: parseCsv(draft.groups),
        disabled: draft.disabled
      }
      if (draft.password) set.passwordHash = `demo:${draft.password}`
      return set
    },
    buildNewDoc: (id) => ({
      _id: id,
      login: "new_user",
      passwordHash: "demo:password",
      groups: ["viewer"],
      disabled: false
    }),
    notices: { saved: "Пользователь сохранён", added: "Пользователь добавлен, пароль: password", removed: "Пользователь удалён" }
  },

  _group: {
    idPrefix: "group_",
    columns: [
      { key: "_id", label: "ID" },
      { key: "name", label: "Название" }
    ],
    fields: [
      { key: "_id", label: "ID", type: "text", disabled: true },
      { key: "name", label: "Название", type: "text" }
    ],
    emptyDraft: () => ({ _id: "", name: "" }),
    fromDoc: (doc) => ({ _id: doc?._id ?? "", name: doc?.name ?? "" }),
    toPatch: (draft) => ({ name: draft.name }),
    buildNewDoc: (id) => ({ _id: id, name: "Новая группа" }),
    notices: { saved: "Группа сохранена", added: "Группа добавлена", removed: "Группа удалена" }
  },

  _permission: {
    idPrefix: "perm_",
    rawJson: true,
    columns: [
      { key: "_id", label: "ID" },
      { key: "table", label: "Таблица" },
      { key: "priority", label: "Приоритет" },
      { key: "read.groups", label: "Чтение" },
      { key: "write.groups", label: "Запись" }
    ],
    emptyDraft: () => "",
    fromDoc: (doc) => doc ? JSON.stringify(cleanDoc(stripId(doc)), null, 2) : "",
    toPatch: (draft) => stripId(JSON.parse(draft)),
    buildNewDoc: (id) => ({
      _id: id,
      table: "order",
      priority: 0,
      read: { groups: ["viewer"], fields: ["_id", "status"] },
      write: { groups: ["viewer"], action: false }
    }),
    notices: { saved: "Правило сохранено", added: "Правило добавлено", removed: "Правило удалено" }
  }
}

export function useAdminState() {
  const activeTab = ref("orders")
  const login = ref("admin")
  const password = ref("admin")
  const notice = ref("")
  const error = ref("")
  const loading = state.getKeyRef("admin")

  const tableQueries = Object.fromEntries(
    Object.keys(tableConfigs).map((table) => [table, { sort: { _id: 1 } }])
  )
  const idsRefs = Object.fromEntries(
    Object.entries(tableQueries).map(([table, query]) => [table, state[table].idsRef(query)])
  )
  const listRefs = Object.fromEntries(
    Object.entries(tableQueries).map(([table, query]) => [table, state[table].listRef(query, "admin")])
  )
  const countRefs = Object.fromEntries(
    Object.keys(tableConfigs).map((table) => [table, state[table].countRef({})])
  )

  const selected = reactive(Object.fromEntries(Object.keys(tableConfigs).map((table) => [table, ""])))
  const tableErrors = reactive(Object.fromEntries(Object.keys(tableConfigs).map((table) => [table, ""])))
  const drafts = reactive(Object.fromEntries(
    Object.entries(tableConfigs).map(([table, config]) => [table, config.emptyDraft()])
  ))
  const originals = reactive(Object.fromEntries(
    Object.entries(tableConfigs).map(([table, config]) => [table, config.emptyDraft()])
  ))

  const active = computed(() => tabs.find((tab) => tab.id === activeTab.value))
  const activeConfig = computed(() => tableConfigs[active.value.table])
  const currentIds = computed(() => idsRefs[active.value.table]?.value ?? [])
  const currentColumns = computed(() => activeConfig.value.columns)
  const currentFields = computed(() => activeConfig.value.fields ?? [])
  const currentRows = computed(() => (listRefs[active.value.table]?.value ?? []).map(cleanDoc))
  const currentDoc = computed(() => selectedDoc(active.value.table))
  const visibleDocJson = computed(() => JSON.stringify(cleanDoc(currentDoc.value ?? {}), null, 2))
  const accountLabel = computed(() => accounts.find((item) => item.login === login.value)?.label ?? login.value)
  const authorizedAccountLabel = computed(() => {
    const loginByUserId = String(state.auth.userId ?? "").replace(/^u_/, "")
    return accounts.find((item) => item.login === loginByUserId)?.label ?? state.auth.userId ?? accountLabel.value
  })
  const connectionText = computed(() => state.sync.connected ? "онлайн" : "нет связи")
  const authText = computed(() => {
    if (state.auth.status === "authorized") return "авторизован"
    if (state.auth.status === "restored") return "локальный доступ"
    if (state.auth.status === "authorizing") return "проверка"
    return "анонимно"
  })
  const syncText = computed(() => state.sync.status === "syncing" ? "синхронизация" : state.sync.status)
  const stats = computed(() => ({
    orders: countRefs.order.value,
    users: countRefs._user.value,
    groups: countRefs._group.value,
    permissions: countRefs._permission.value
  }))

  watch(currentIds, (ids) => {
    const table = active.value.table
    if (!ids.length) {
      if (selected[table]) {
        selected[table] = ""
        syncDraft(table)
      }
      return
    }

    if (!selected[table] || !ids.includes(selected[table])) {
      selected[table] = ids[0]
      syncDraft(table)
    }
  }, { immediate: true })

  watchEffect(() => {
    syncDraft(active.value.table)
  })

  async function signIn() {
    await run(async () => {
      if (state.auth.status !== "anonymous") {
        await state.logout()
      }
      await state.clearLocalDB()
      await state.login(login.value, password.value)
      await state.syncNow()
      notice.value = `Вход выполнен: ${accountLabel.value}`
    })
  }

  async function signOut() {
    await run(async () => {
      await state.logout()
      await state.clearLocalDB()
      resetSelection()
      notice.value = "Выход выполнен"
    })
  }

  async function refreshAll() {
    await state.syncNow()
  }

  async function refreshTable(table) {
    tableErrors[table] = ""

    try {
      await state.syncNow()
      const tableIds = idsRefs[table]?.value ?? []
      if (!selected[table] || !tableIds.includes(selected[table])) {
        selected[table] = tableIds[0] ?? ""
      }
      syncDraft(table)
    } catch (err) {
      tableErrors[table] = err.message
    }
  }

  function selectRow(table, id) {
    selected[table] = id
    syncDraft(table)
  }

  function selectedDoc(table) {
    const id = selected[table]
    return id ? state[table].load(id, "admin") : undefined
  }

  function syncDraft(table) {
    const config = tableConfigs[table]
    if (!config) return
    const doc = selectedDoc(table)
    const next = config.fromDoc(doc)

    if (config.rawJson) {
      drafts[table] = next
      originals[table] = next
    } else {
      Object.assign(drafts[table], next)
      Object.assign(originals[table], next)
    }
  }

  async function saveTable(table) {
    await run(async () => {
      const config = tableConfigs[table]
      const id = config.rawJson ? selected[table] : drafts[table]._id

      if (!id) throw new Error("Нечего сохранять: запись не выбрана")

      const nextPatch = config.toPatch(drafts[table])
      const originalPatch = config.toPatch(originals[table])
      const patch = diffSet(originalPatch, nextPatch)

      if (Object.keys(patch).length === 0) {
        notice.value = "Изменений нет"
        return
      }

      await state[table].update({ id, objedit: patch })
      await refreshTable(table)
      notice.value = config.notices.saved
    })
  }

  async function addTable(table) {
    await run(async () => {
      const config = tableConfigs[table]
      const id = `${config.idPrefix}${crypto.randomUUID()}`
      const doc = config.buildNewDoc(id)
      await state[table].add(doc)
      await refreshTable(table)
      selectRow(table, id)
      notice.value = config.notices.added
    })
  }

  async function deleteTable(table) {
    await run(async () => {
      if (!selected[table]) return
      await state[table].remove(selected[table])
      await refreshTable(table)
      notice.value = tableConfigs[table].notices.removed
    })
  }

  async function run(action) {
    error.value = ""
    notice.value = ""

    try {
      await action()
    } catch (err) {
      error.value = err.message
    }
  }

  function resetSelection() {
    for (const table of Object.keys(selected)) {
      selected[table] = ""
      tableErrors[table] = ""
      syncDraft(table)
    }
  }

  return {
    accounts,
    active,
    activeConfig,
    activeTab,
    addTable,
    authText,
    authorizedAccountLabel,
    cleanDoc,
    connectionText,
    currentDoc,
    currentColumns,
    currentFields,
    currentIds,
    currentRows,
    deleteTable,
    drafts,
    error,
    loading,
    login,
    notice,
    password,
    refreshAll,
    refreshTable,
    saveTable,
    selectRow,
    selected,
    signIn,
    signOut,
    state,
    stats,
    syncDraft,
    syncText,
    tableErrors,
    tabs,
    visibleDocJson
  }
}

function parseCsv(value) {
  return String(value).split(",").map((item) => item.trim()).filter(Boolean)
}

export function cleanDoc(doc) {
  return Object.fromEntries(Object.entries(doc ?? {}).filter(([key]) => !key.startsWith("__")))
}

function stripId(doc) {
  const { _id, id, ...rest } = doc
  return rest
}

function diffSet(original, next) {
  const out = {}
  for (const [key, value] of Object.entries(next)) {
    if (!isDeepEqual(original?.[key], value)) {
      out[key] = value
    }
  }
  return out
}

function isDeepEqual(a, b) {
  if (a === b) return true
  if (a == null || b == null) return a === b
  if (typeof a !== typeof b) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, i) => isDeepEqual(item, b[i]))
  }
  if (typeof a === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const key of keys) {
      if (!isDeepEqual(a[key], b[key])) return false
    }
    return true
  }
  return false
}
