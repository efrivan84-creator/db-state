# Cookbook: admin panel

This recipe builds a practical multi-table admin panel: list rows, edit the selected record, manage users/groups/permissions, and update other tabs in realtime.

## Goal

Use db-state as the data layer for an admin UI where page code stays small:

```js
const orders = state.order.listRef({ sort: { _id: 1 } }, "orders")
const selectedOrder = computed(() => state.order.load(selectedId.value, "orders"))

await state.order.update({ id: selectedId.value, set: changedFields })
```

No manual polling, no Vuex/Pinia boilerplate, no local "server cache" layer.

## Client state singleton

Create one state object and use it across the app:

```js
// src/state.js
import { createDbState } from "@db-state/vue"

export const state = createDbState({
  tables: ["order", "_user", "_group"],
  wsUrl: "ws://127.0.0.1:8788/db-state/ws",
  sessionKey: "admin.sessionId",
  syncKey: "admin.time1",
  authKey: "admin.auth"
})
```

Service tables are listed explicitly to expose them in the admin UI:

```js
state._user
state._group
```

Access is still controlled by the server.

## Reactive table lists

Use `listRef` for visible rows and `countRef` for counters:

```js
const tabs = [
  { label: "Orders", table: "order" },
  { label: "Users", table: "_user" },
  { label: "Groups", table: "_group" }   // групповой access редактируется здесь
]

const query = { sort: { _id: 1 } }

const lists = {
  order: state.order.listRef(query, "admin"),
  _user: state._user.listRef(query, "admin"),
  _group: state._group.listRef(query, "admin")
}

const counts = {
  order: state.order.countRef({}),
  _user: state._user.countRef({}),
  _group: state._group.countRef({})
}
```

`listRef` is only `idsRef(query)` plus `load(id)`. It deduplicates the id query and loads documents from cache/server as needed.

Do not add a second loop like:

```js
await Promise.all(ids.map((id) => state.order.getAsync(id)))
```

That creates an unnecessary RPC per row. Let `listRef` pull documents.

## Selected record

Keep selection as page state:

```js
const selected = reactive({
  order: "",
  _user: "",
  _group: ""
})

const currentRows = computed(() => lists[activeTable.value].value)
const currentIds = computed(() => currentRows.value.map((row) => row._id))
const currentDoc = computed(() => {
  const id = selected[activeTable.value]
  return id ? state[activeTable.value].load(id, "admin") : undefined
})
```

When ids arrive from IndexedDB or sync, select the first available row if nothing is selected:

```js
watch(currentIds, (ids) => {
  const table = activeTable.value
  if (!selected[table] || !ids.includes(selected[table])) {
    selected[table] = ids[0] ?? ""
  }
}, { immediate: true })
```

## Draft form

For forms, keep a draft object separate from the reactive database document:

```js
const draft = reactive({
  status: "",
  total: 0,
  comment: ""
})

watch(currentDoc, (doc) => {
  Object.assign(draft, {
    status: doc?.status ?? "",
    total: doc?.total ?? 0,
    comment: doc?.comment ?? ""
  })
}, { deep: true, immediate: true })
```

This keeps the editor ergonomic while the visible read model remains reactive.

## Diff-based saves

Send only changed fields. This reduces accidental overwrites and works well with field-level permissions:

```js
function diff(original, draft, fields) {
  const set = {}

  for (const field of fields) {
    if (draft[field] !== original?.[field]) {
      set[field] = draft[field]
    }
  }

  return set
}

async function saveOrder() {
  const set = diff(currentDoc.value, draft, ["status", "total", "comment"])
  if (Object.keys(set).length === 0) return

  await state.order.update({
    id: currentDoc.value._id,
    set
  })
}
```

If a manager is allowed to write only `status` and `comment`, trying to send `total` will reject the whole operation. Diff-based saves make it easy to send only what the form should write.

## Server permissions

Rights are `access` objects on groups — seed the groups themselves:

```js
await db.collection("_group").insertMany([
  {
    _id: "admin",
    name: "Administrators",
    access: {
      order:  { read: {}, write: {} },
      _user:  { read: {}, write: {} },
      _group: { read: {}, write: {} }
    }
  },
  {
    _id: "manager",
    name: "Order managers",
    access: {
      order: {
        read: {}, read_fields: ["status", "total", "comment", "ownerId"],
        write: {}, write_fields: ["status", "comment"]
      }
    }
  },
  {
    _id: "viewer",
    name: "Read only",
    access: {
      order: { read: {}, read_fields: ["status", "total"] }
    }
  }
])
```

The admin UI edits these `access` objects directly in the Groups tab (a JSON editor works well — see demo2). Changes apply to each user at their next login or reconnect.

## Refresh button

The refresh button should trigger one sync, not row-by-row loads:

```js
async function refreshTable(table) {
  tableErrors[table] = ""

  try {
    await state.syncNow()
    const ids = lists[table].value.map((row) => row._id)
    if (!ids.includes(selected[table])) selected[table] = ids[0] ?? ""
  } catch (error) {
    tableErrors[table] = error.message
  }
}
```

`listRef` will update visible rows as the sync changes arrive.

## Production checklist

- Create indexes: `log({ createdAt: 1, _id: 1 })` plus normal Mongo indexes for fields used in access filters.
- Keep `state` as a singleton.
- Prefer `listRef` for tables and `load(id)` for details.
- Keep drafts separate from database docs.
- Save diffs, not full documents.
- Give admins access to `_user` and `_group`.
- Do not expose service tables without explicit access grants.
