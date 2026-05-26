import { computed, reactive, ref, watch, watchEffect } from "vue"

import { files, state } from "../state.js"

const tabs = [
  { id: "orders", label: "Заказы", table: "order", hint: "Операции, суммы, маржа и ответственные" },
  { id: "users", label: "Пользователи", table: "_user", hint: "Логины, группы и блокировка доступа" },
  { id: "groups", label: "Группы", table: "_group", hint: "Группы клиентов без ролей" },
  { id: "permissions", label: "Права", table: "_permission", hint: "Правила чтения, записи, условий и полей" },
  { id: "files", label: "Файлы", table: "file", hint: "Metadata, tokens, политики и WebSocket chunks" },
  { id: "audit", label: "Аудит", table: "log", hint: "Append-only log: кто, когда и что изменил" }
]

const accounts = [
  { login: "admin", label: "Администратор" },
  { login: "manager", label: "Менеджер" },
  { login: "viewer", label: "Наблюдатель" }
]

const tableConfigs = {
  order: {
    idPrefix: "o",
    query: {
      searchPlaceholder: "ID, статус, ответственный, комментарий",
      searchFields: ["_id", "status", "ownerId", "comment"],
      filters: [
        { key: "status", label: "Статус", field: "status", all: "Все статусы", options: ["open", "packed", "done", "closed"] }
      ],
      sort: [
        { value: "_id:1", label: "ID ↑" },
        { value: "_id:-1", label: "ID ↓" },
        { value: "total:-1", label: "Сумма ↓" },
        { value: "status:1", label: "Статус ↑" }
      ],
      pageSizes: [3, 5, 10]
    },
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

  file: {
    idPrefix: "file_",
    readonly: true,
    managedBy: "file-api",
    query: {
      searchPlaceholder: "Имя, MIME или ID",
      searchFields: ["_id", "name", "mime"],
      filters: [
        { key: "status", label: "Статус", field: "status", all: "Все статусы", options: ["uploading", "ready", "failed"] },
        { key: "policy", label: "Доступ", field: "downloadPolicy.mode", all: "Все политики", options: ["public", "registered", "verified", "groups"] }
      ],
      sort: [
        { value: "info.makedata:-1", label: "Новые сверху" },
        { value: "name:1", label: "Имя ↑" },
        { value: "size:-1", label: "Размер ↓" }
      ],
      pageSizes: [5, 10, 20]
    },
    columns: [
      { key: "_id", label: "ID" },
      { key: "name", label: "Имя" },
      { key: "mime", label: "MIME" },
      { key: "size", label: "Размер" },
      { key: "status", label: "Статус" },
      { key: "downloadPolicy.mode", label: "Доступ" }
    ],
    fields: [
      { key: "_id", label: "ID", type: "text", disabled: true },
      { key: "name", label: "Имя файла", type: "text", disabled: true },
      { key: "mime", label: "MIME", type: "text", disabled: true },
      { key: "size", label: "Размер", type: "number", disabled: true },
      { key: "status", label: "Статус", type: "text", disabled: true },
      { key: "ownerId", label: "Владелец", type: "text", disabled: true },
      { key: "token", label: "Token", type: "textarea", colSpan: 2, disabled: true }
    ],
    emptyDraft: () => ({ _id: "", name: "", mime: "", size: 0, status: "", ownerId: "", token: "" }),
    fromDoc: (doc) => ({
      _id: doc?._id ?? "",
      name: doc?.name ?? "",
      mime: doc?.mime ?? "",
      size: doc?.size ?? 0,
      status: doc?.status ?? "",
      ownerId: doc?.ownerId ?? "",
      token: doc?.token ?? ""
    }),
    toPatch: () => ({}),
    buildNewDoc: () => {
      throw new Error("Файлы добавляются через upload API")
    },
    notices: { saved: "Файл обновлён", added: "Файл загружен", removed: "Файл удалён" }
  },

  _user: {
    idPrefix: "u_",
    query: {
      searchPlaceholder: "ID, логин или группа",
      searchFields: ["_id", "login", "groups"],
      filters: [
        { key: "disabled", label: "Блокировка", field: "disabled", all: "Все", options: [{ value: false, label: "Активные" }, { value: true, label: "Заблокированные" }] }
      ],
      sort: [
        { value: "_id:1", label: "ID ↑" },
        { value: "login:1", label: "Логин ↑" }
      ],
      pageSizes: [5, 10, 20]
    },
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
    query: {
      searchPlaceholder: "ID или название",
      searchFields: ["_id", "name"],
      sort: [
        { value: "_id:1", label: "ID ↑" },
        { value: "name:1", label: "Название ↑" }
      ],
      pageSizes: [5, 10, 20]
    },
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
    query: {
      searchPlaceholder: "ID или таблица",
      searchFields: ["_id", "table"],
      filters: [
        { key: "table", label: "Таблица", field: "table", all: "Все таблицы", options: ["order", "file", "log", "_user", "_group", "_permission"] }
      ],
      sort: [
        { value: "priority:-1", label: "Приоритет ↓" },
        { value: "table:1", label: "Таблица ↑" },
        { value: "_id:1", label: "ID ↑" }
      ],
      pageSizes: [5, 10, 20]
    },
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
  },

  log: {
    idPrefix: "log_",
    readonly: true,
    rawJson: true,
    query: {
      searchPlaceholder: "ID записи, таблица, документ или пользователь",
      searchFields: ["_id", "logId", "table", "id", "userId"],
      filters: [
        { key: "table", label: "Таблица", field: "table", all: "Все таблицы", options: ["order", "file", "_user", "_group", "_permission"] },
        { key: "action", label: "Действие", field: "action", all: "Все действия", options: ["insert", "update", "delete"] }
      ],
      sort: [
        { value: "createdAt:-1", label: "Новые сверху" },
        { value: "createdAt:1", label: "Старые сверху" },
        { value: "table:1", label: "Таблица ↑" }
      ],
      pageSizes: [5, 10, 20]
    },
    columns: [
      { key: "createdAt", label: "Дата" },
      { key: "table", label: "Таблица" },
      { key: "action", label: "Действие" },
      { key: "id", label: "Документ" },
      { key: "userId", label: "Кто" },
      { key: "sessionId", label: "Сессия" }
    ],
    emptyDraft: () => "",
    fromDoc: (doc) => doc ? JSON.stringify(cleanDoc(doc), null, 2) : "",
    toPatch: () => ({}),
    buildNewDoc: () => {
      throw new Error("Log доступен только для чтения")
    },
    notices: { saved: "Log не редактируется", added: "Log не редактируется", removed: "Log не редактируется" }
  }
}

export function useAdminState() {
  const activeTab = ref("orders")
  const login = ref("admin")
  const password = ref("admin")
  const notice = ref("")
  const error = ref("")
  const loading = state.getKeyRef("admin")
  const fileTransfer = reactive({
    active: false,
    loaded: 0,
    total: 0,
    percent: 0,
    mode: ""
  })
  const filePolicy = ref("registered")
  const filePolicyOptions = [
    { value: "registered", label: "Только авторизованные" },
    { value: "public", label: "Публичный token" },
    { value: "groups:manager", label: "Группа manager" },
    { value: "groups:admin", label: "Группа admin" }
  ]

  const queryControls = reactive(Object.fromEntries(
    Object.entries(tableConfigs).map(([table, config]) => [table, defaultQueryControl(config)])
  ))
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
  const currentQueryConfig = computed(() => activeConfig.value.query ?? {})
  const currentQueryControl = computed(() => queryControls[active.value.table])
  const currentFilter = computed(() => filterFor(active.value.table))
  const currentQuery = computed(() => queryFor(active.value.table))
  const currentIds = computed(() => state[active.value.table]?.idsRef(currentQuery.value).value ?? [])
  const currentColumns = computed(() => activeConfig.value.columns)
  const currentFields = computed(() => activeConfig.value.fields ?? [])
  const currentRows = computed(() => (state[active.value.table]?.listRef(currentQuery.value, "admin").value ?? []).map(cleanDoc))
  const currentTotal = computed(() => state[active.value.table]?.countRef(currentFilter.value).value ?? 0)
  const currentPageCount = computed(() => Math.max(1, Math.ceil(currentTotal.value / Number(currentQueryControl.value.pageSize || 1))))
  const currentPageStart = computed(() => currentTotal.value === 0 ? 0 : currentQueryControl.value.page * currentQueryControl.value.pageSize + 1)
  const currentPageEnd = computed(() => Math.min(currentTotal.value, (currentQueryControl.value.page + 1) * currentQueryControl.value.pageSize))
  const currentDoc = computed(() => selectedDoc(active.value.table))
  const selectedFileDoc = computed(() => selectedDoc("file"))
  const selectedFileUrl = computed(() => selectedFileDoc.value?.token ? files.url(selectedFileDoc.value.token) : "")
  const visibleDocJson = computed(() => JSON.stringify(cleanDoc(currentDoc.value ?? {}), null, 2))
  const accountLabel = computed(() => accounts.find((item) => item.login === login.value)?.label ?? login.value)
  const authorizedLogin = computed(() => String(state.auth.userId ?? "").replace(/^u_/, ""))
  const authorizedAccountLabel = computed(() => {
    return accounts.find((item) => item.login === authorizedLogin.value)?.label ?? state.auth.userId ?? accountLabel.value
  })
  const currentWritableFieldKeys = computed(() => writableFieldKeys(active.value.table))
  const currentChangedFieldKeys = computed(() => Object.keys(changedPatch(active.value.table)))
  const currentPatch = computed(() => writablePatch(active.value.table))
  const currentPatchPreview = computed(() => JSON.stringify(currentPatch.value, null, 2))
  const canSave = computed(() => Boolean(selected[active.value.table]) && Object.keys(currentPatch.value).length > 0)
  const canAdd = computed(() => !activeConfig.value.readonly)
  const canDelete = computed(() => Boolean(selected[active.value.table]) && !activeConfig.value.readonly)
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
    permissions: countRefs._permission.value,
    files: countRefs.file.value,
    log: countRefs.log.value
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

  watch(currentPageCount, (pageCount) => {
    const control = currentQueryControl.value
    if (control.page >= pageCount) control.page = Math.max(0, pageCount - 1)
  })

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
      const tableIds = state[table]?.idsRef(queryFor(table)).value ?? []
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

  function setSearch(value) {
    const control = currentQueryControl.value
    control.search = value
    control.page = 0
  }

  function setQueryFilter(key, value) {
    const control = currentQueryControl.value
    control.filters[key] = value
    control.page = 0
  }

  function setSort(value) {
    const control = currentQueryControl.value
    control.sort = value
    control.page = 0
  }

  function setPageSize(value) {
    const control = currentQueryControl.value
    control.pageSize = Number(value)
    control.page = 0
  }

  function setPage(delta) {
    const control = currentQueryControl.value
    control.page = Math.min(Math.max(0, control.page + delta), currentPageCount.value - 1)
  }

  function filterFor(table) {
    return buildFilter(tableConfigs[table], queryControls[table])
  }

  function queryFor(table) {
    const control = queryControls[table]
    const limit = Number(control.pageSize)
    return {
      filter: filterFor(table),
      sort: parseSortValue(control.sort),
      skip: control.page * limit,
      limit
    }
  }

  async function uploadFile(file, policyMode = filePolicy.value) {
    await run(async () => {
      if (!file) throw new Error("Выберите файл для загрузки")
      try {
        const uploaded = await files.upload(file, {
          policy: filePolicyValue(policyMode),
          onProgress: (progress) => setFileProgress("upload", progress)
        })
        selected.file = uploaded.id
        await refreshTable("file")
        notice.value = `Файл загружен: ${uploaded.file.name}`
      } finally {
        resetFileProgress()
      }
    })
  }

  async function downloadSelectedFile() {
    await run(async () => {
      const file = selectedFileDoc.value
      if (!file?.token) throw new Error("У выбранного файла нет token")
      try {
        const blob = await files.download(file.token, {
          onProgress: (progress) => setFileProgress("download", progress)
        })
        const url = URL.createObjectURL(blob)
        const link = document.createElement("a")
        link.href = url
        link.download = file.name || "download.file"
        link.click()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
        notice.value = `Файл скачан: ${file.name}`
      } finally {
        resetFileProgress()
      }
    })
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

  function writableFieldKeys(table) {
    if (tableConfigs[table]?.readonly) return []

    const account = authorizedLogin.value

    if (account === "admin") {
      if (table === "_permission") return Object.keys(changedPatch(table))
      return (tableConfigs[table]?.fields ?? [])
        .filter((field) => !field.disabled)
        .map((field) => field.key)
    }

    if (account === "manager" && table === "order") return ["status", "comment"]
    return []
  }

  function changedPatch(table) {
    const config = tableConfigs[table]
    if (!config) return {}
    const nextPatch = config.toPatch(drafts[table])
    const originalPatch = config.toPatch(originals[table])
    return diffSet(originalPatch, nextPatch)
  }

  function writablePatch(table) {
    const keys = writableFieldKeys(table)
    const patchKeys = table === "_user" && keys.includes("password") ? [...keys, "passwordHash"] : keys
    return pickKeys(changedPatch(table), patchKeys)
  }

  async function saveTable(table) {
    await run(async () => {
      const config = tableConfigs[table]
      const id = config.rawJson ? selected[table] : drafts[table]._id

      if (!id) throw new Error("Нечего сохранять: запись не выбрана")

      const patch = table === active.value.table ? currentPatch.value : writablePatch(table)

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
      if (config.readonly) throw new Error("Эта таблица управляется отдельным API")
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
      if (tableConfigs[table].readonly) throw new Error("Эта таблица управляется отдельным API")
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

  function setFileProgress(mode, progress) {
    fileTransfer.active = true
    fileTransfer.mode = mode
    fileTransfer.loaded = progress.loaded
    fileTransfer.total = progress.total
    fileTransfer.percent = Math.round(progress.percent)
  }

  function resetFileProgress() {
    fileTransfer.active = false
    fileTransfer.loaded = 0
    fileTransfer.total = 0
    fileTransfer.percent = 0
    fileTransfer.mode = ""
  }

  return {
    accounts,
    active,
    activeConfig,
    activeTab,
    addTable,
    authText,
    authorizedAccountLabel,
    canAdd,
    canDelete,
    canSave,
    cleanDoc,
    connectionText,
    currentChangedFieldKeys,
    currentDoc,
    currentColumns,
    currentFields,
    currentIds,
    currentPageCount,
    currentPageEnd,
    currentPageStart,
    currentPatch,
    currentPatchPreview,
    currentQueryConfig,
    currentQueryControl,
    currentRows,
    currentTotal,
    currentWritableFieldKeys,
    deleteTable,
    downloadSelectedFile,
    drafts,
    error,
    filePolicy,
    filePolicyOptions,
    fileTransfer,
    loading,
    login,
    notice,
    password,
    refreshAll,
    refreshTable,
    saveTable,
    selectRow,
    selected,
    selectedFileDoc,
    selectedFileUrl,
    setPage,
    setPageSize,
    setQueryFilter,
    setSearch,
    setSort,
    signIn,
    signOut,
    state,
    stats,
    syncDraft,
    syncText,
    tableErrors,
    tabs,
    uploadFile,
    visibleDocJson
  }
}

function defaultQueryControl(config) {
  const query = config.query ?? {}
  return {
    search: "",
    filters: Object.fromEntries((query.filters ?? []).map((filter) => [filter.key, ""])),
    sort: query.sort?.[0]?.value ?? "_id:1",
    page: 0,
    pageSize: query.pageSizes?.[0] ?? 10
  }
}

function buildFilter(config, control) {
  const query = config.query ?? {}
  const filter = {}

  for (const item of query.filters ?? []) {
    const value = control.filters[item.key]
    if (value !== "" && value != null) filter[item.field ?? item.key] = value
  }

  const search = String(control.search ?? "").trim()
  if (search && query.searchFields?.length) {
    filter.$or = query.searchFields.map((field) => ({
      [field]: { $regex: escapeRegex(search), $options: "i" }
    }))
  }

  return filter
}

function parseSortValue(value) {
  const [field, direction = "1"] = String(value || "_id:1").split(":")
  return { [field]: Number(direction) || 1 }
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function filePolicyValue(mode) {
  if (mode === "public") return { mode: "public" }
  if (mode === "groups:manager") return { mode: "groups", groups: ["manager"] }
  if (mode === "groups:admin") return { mode: "groups", groups: ["admin"] }
  return { mode: "registered" }
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

function pickKeys(obj, keys) {
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(obj, key)).map((key) => [key, obj[key]]))
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
