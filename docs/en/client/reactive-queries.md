# Reactive queries

The Vue client exposes four query primitives per table. All of them are **reactive**, **cached**, and **automatically updated** as the server pushes changes.

## Quick reference

| Method | Returns | Use when |
|---|---|---|
| [`load(id, key?)`](#load) | `ReactiveDoc<T>` | You have an id and want one document. |
| [`idsRef(query?)`](#idsref) | `Ref<string[]>` | You need just the matching ids (e.g. for pagination). |
| [`listRef(query?, key?)`](#listref) | `ComputedRef<ReactiveDoc<T>[]>` | You want the full list of matching documents. |
| [`countRef(filter?)`](#countref) | `Ref<number>` | You want the count of matching documents. |
| [`getAsync(id, key?)`](#getasync) | `Promise<ReactiveDoc<T>>` | You want to await a load (e.g. in a route guard). |
| [`getIds(query?, key?)`](#getids) | `Promise<string[]>` | One-off fetch of ids; not reactive. |
| [`getUnique({field, filter?})`](#getunique) | `Promise<V[]>` | Distinct values of one field on the server. |

## `load`

Returns a single reactive document by id. Loads it from cache or server in the background.

```js
const order = state.order.load("o1")
// order is a Vue reactive object, returned immediately.
// order.__loaded becomes true once data arrives.

watchEffect(() => {
  if (order.__loaded) {
    console.log("loaded:", order.status, order.total)
  }
})
```

Key properties:

- **Idempotent**: calling `load("o1")` twice returns the **same reactive object** — no second fetch.
- **Cache-first**: if the document is in IndexedDB, it's returned synchronously and shown immediately.
- **Auth-safe**: if cache misses before the socket is authorized, no protected RPC is sent; `__loaded` stays false and the document is retried after authorization.
- **Auto-updated**: when the server pushes an update for `o1` via sync, the same reactive object is patched in place.
- Returns `undefined` only when `id` is `null` / `undefined`.

This means page code can freely read different paths from the same row without coordinating requests:

```js
state.user.load(userId, "profile").profile.name
state.user.load(userId, "profile").profile.phone
state.user.load(userId, "profile").settings.theme
```

For the same table/id, the document loads once, every call receives the same object, remote updates patch that object, and all Vue consumers update automatically.

### Loading keys

```js
const order = state.order.load("o1", "order-page")
const customer = state.user.load(order.customerId, "order-page")

// Track combined loading state for the whole page:
const loading = state.getKeyRef("order-page")
// loading.value       = active operations for "order-page"
// loading.max         = peak active operations in the current wave
// loading.start       = false until the first operation starts
// loading.percent     = active operations left: loading.value / loading.max * 100
// 100 - loading.percent is the completed percentage for a filling progress bar
// loading.ready.value = true when loading.value === 0
```

Use loading keys when you have several related loads on one page and want a single "is everything ready" or progress signal. The same key can also wrap writes, so a page or form can show the progress of submitted changes with the same object.

### Error handling

```js
const order = state.order.load("o1")

watchEffect(() => {
  const error = state.order.getError("o1")
  if (error) {
    console.error("failed to load o1:", error.message)
  }
})

// Or:
if (state.order.isLoading("o1")) showSpinner()
```

## `idsRef`

Returns a reactive ref of ids matching a server query.

```js
const ids = state.order.idsRef({
  filter: { status: "open" },
  sort: { createdAt: -1 },
  skip: 0,
  limit: 50
})

// ids.value = ["o1", "o2", "o3", ...]
```

Refreshed automatically when:

- The client logs in for the first time.
- Hash auth succeeds and this ref had no cached value yet.
- A `sync` brings changes for this table.
- A local mutation (`update`/`add`/`remove`) on this table succeeds.

Cached refs are **not** refreshed by `authByHash` reconnects or page refresh by themselves — only if sync returns changes. This keeps page refresh offline-fast and avoids extra query RPCs for data already restored from IndexedDB.

### Deduplication

`idsRef` is deduplicated **per table by stable query key**:

```js
state.order.idsRef({ filter: { status: "open" }, limit: 10 })
state.order.idsRef({ limit: 10, filter: { status: "open" } })
// ↑ same ref — key order does not matter
```

Same filter + sort + skip + limit → same ref instance, no extra server roundtrip.

### Persistence

Last value is written to IndexedDB under a special `__dbstate_query` table. On page load, the ref initializes to the cached value so the UI shows previous results immediately. If no cached value exists, the ref stays empty/not loaded until authorization, then refreshes from the server.

## `listRef`

Returns a `computed` list of reactive documents. Internally combines `idsRef` + `load`:

```js
const orders = state.order.listRef({
  filter: { status: "open" },
  sort: { createdAt: -1 }
}, "orders-page")

// orders.value = [<reactive order>, <reactive order>, ...]
```

Equivalent to:

```js
const ids = state.order.idsRef({...})
const orders = computed(() => ids.value.map((id) => state.order.load(id, "orders-page")))
```

There is no second cache of objects — `listRef` reuses the global per-table reactive store. Every document in the list is the **same reactive object** you'd get from `load(id)` elsewhere — so editing a doc in a detail view updates it in the list automatically.

### Pattern: master + detail

```vue
<script setup>
import { ref } from "vue"
import { state } from "./state"

const list = state.order.listRef({ filter: { status: "open" } }, "orders")
const selectedId = ref(null)
const selected = computed(() =>
  selectedId.value ? state.order.load(selectedId.value, "orders") : null
)
</script>

<template>
  <ul>
    <li v-for="o in list" :key="o._id" @click="selectedId = o._id">
      {{ o.status }} — {{ o.total }}
    </li>
  </ul>
  <pre v-if="selected">{{ selected }}</pre>
</template>
```

The detail and the list share the same reactive object — editing in one is visible in the other instantly.

## `countRef`

```js
const openCount = state.order.countRef({ status: "open" })
// openCount.value = number
```

Same deduplication and persistence rules as `idsRef`. Use this for badges, KPIs, dashboard tiles.

### Pattern: multi-filter counts on one dashboard

```js
const tiles = {
  open: state.order.countRef({ status: "open" }),
  packed: state.order.countRef({ status: "packed" }),
  shipped: state.order.countRef({ status: "shipped" })
}
// tiles.open.value, tiles.packed.value, tiles.shipped.value
```

Each call deduplicates — three filters = three refs. Subsequent calls with the same filters return existing refs.

## `getAsync`

Promise-based variant of `load`. Resolves when the document is fully loaded or the load errors out.

```js
const order = await state.order.getAsync("o1", "order-page")
if (!order) {
  // Either an error happened or the timeout elapsed.
  console.error(state.order.getError("o1"))
}
```

Useful in route guards:

```js
router.beforeEach(async (to) => {
  if (to.name === "order") {
    const order = await state.order.getAsync(to.params.id)
    if (!order) return { name: "404" }
  }
})
```

If the document is not in cache and the socket is not authorized yet, `getAsync` waits for authorization before sending the RPC. The default post-RPC wait timeout is 15s and is controlled by `waitTimeout` in `createDbState` options. For UI, prefer `load()` because it returns a reactive object immediately and can update later.

## `getIds`

One-off non-reactive id fetch:

```js
const ids = await state.order.getIds({ filter: { status: "open" } }, "report")
```

Use when you need just the result once (e.g. for a CSV export or an ad-hoc report). Use `idsRef` for anything live.

`getIds` waits until `state.auth.status === "authorized"` before sending the RPC. It is not reactive and does not read/write the query cache.

## `getUnique`

Distinct values for one field on the server, after permission filtering:

```js
const statuses = await state.order.getUnique({ field: "status" })
// ["open", "packed", "shipped", "closed"]

const ownerIds = await state.order.getUnique({
  field: "ownerId",
  filter: { status: "open" }
})
```

Useful for building filter dropdowns. Field-level read permissions still apply — if a caller can't read `ownerId`, those values are filtered out.

`getUnique` also waits for `authorized` before sending the RPC. For live UI state, prefer a reactive list/count pattern where possible.

## Refresh triggers

A `countRef` / `idsRef` server refresh happens in exactly these cases:

| Trigger | Refreshed? |
|---|:---:|
| First explicit `login()` | ✅ |
| `authByHash` with a ref that missed cache | ✅ |
| Local `update`/`add`/`remove` succeeds | ✅ (debounced) |
| Server pushes `changes_available` for this table | ✅ (debounced) |
| `authByHash` with a cached ref | ❌ unless sync brings changes |
| Page refresh / `restored` auth | ❌ |
| Optional background safety-sync interval | ✅ if enabled and sync brings changes |

The debounce window is `countRefreshDelay` / `idsRefreshDelay` (default 50 ms). This lets bulk imports coalesce into a single server call instead of N.

## Gotchas

### "My countRef shows the old value after a server change"

Two possibilities:
1. **Not logged in yet.** Sync only runs after authentication. The ref shows the last cached value until you `login()`.
2. **The change came from your own session.** The server suppresses echo by `sessionId`. Your local `update()` already applied the change locally — the count updates from that, not from sync.

### "My listRef shows duplicates after navigation"

You're likely creating new refs every render. Move the `listRef` call out of the component body into a module-level `state.js` or a composable's setup:

```js
// ❌ creates a new ref every component instance
const orders = computed(() => state.order.listRef({ filter: { status: "open" } }))

// ✅ same ref reused
const orders = state.order.listRef({ filter: { status: "open" } })
```

(Even the "❌" case wouldn't actually create new refs because of deduplication — but it would be confusing. The clean pattern is to keep query refs as top-level constants.)

### "I want pagination but the list doesn't reset between pages"

Use **separate refs per page** of input:

```js
const page = ref(0)
const pageSize = 50

const ids = computed(() =>
  state.order.idsRef({
    filter: {},
    sort: { createdAt: -1 },
    skip: page.value * pageSize,
    limit: pageSize
  })
)

// Then watch page changes and re-resolve:
const list = computed(() =>
  ids.value.value.map((id) => state.order.load(id))
)
```

Each unique `{ skip, limit }` combination is its own ref — they don't overwrite each other.
