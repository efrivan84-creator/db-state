# TypeScript

`@db-state/vue` ships full `.d.ts` declarations. A single generic parameter — your `Schema` — types every method, filter, sort key, update field and load result.

## Schema generic

```ts
import { createDbState } from "@db-state/vue"

type Schema = {
  order:    { _id: string; status: "open" | "closed"; total: number; createdAt: string }
  product:  { _id: string; sku: string; price: number; stock: number }
  customer: { _id: string; name: string; vipLevel?: 1 | 2 | 3 }
}

export const state = createDbState<Schema>({
  tables: ["order", "product", "customer"]
})
```

Every table accessor (`state.order`, `state.product`, `state.customer`) is typed against its entry in `Schema`.

## What you get

### Typed `load`

```ts
const o = state.order.load("o1")
// o: ReactiveDoc<Schema["order"]> | undefined

o.status     // "open" | "closed"
o.total      // number
o.unknown    // ❌ Property 'unknown' does not exist
```

### Typed `update`

```ts
state.order.update({
  id: "o1",
  set: {
    status: "closed",    // ✅ ok
    total: "100"         // ❌ Type 'string' not assignable to 'number'
  }
})
```

`set` accepts `Partial<T> & Record<string, unknown>` — the `Record` part is there to allow dot-paths (`"profile.city"`), but known keys are strictly typed.

### Typed filters

```ts
state.order.idsRef({
  filter: {
    status: "open",        // ✅
    status: "ready",       // ❌ not in "open" | "closed"
    nonexistent: true      // ✅ — Filter allows extra keys (Mongo-compatible)
  }
})
```

Strict known-key typing for declared fields, permissive for the rest (because Mongo filters can use operators like `$gt` that we can't fully model yet).

### Typed sort

```ts
state.order.idsRef({
  sort: {
    createdAt: -1,    // ✅
    total: 1,         // ✅
    nope: -1          // ✅ — same permissive escape hatch
  }
})
```

### Typed `listRef`

```ts
const orders = state.order.listRef({
  filter: { status: "open" },
  sort: { createdAt: -1 }
})
// orders: ComputedRef<ReactiveDoc<Schema["order"]>[]>

orders.value[0]?.status   // "open" | "closed"
```

### Typed `countRef`

```ts
const n = state.order.countRef({ status: "open" })
// n: Ref<number>
```

## Service tables

`_user`, `_group`, `_permission` are typed automatically with default shapes:

```ts
state._user.load("u1")
// ReactiveDoc<{ _id; login; passwordHash; hash?; groups?; disabled? }>
```

Override them in your schema if you have extra fields:

```ts
type Schema = {
  order: { ... },
  _user: {
    _id: string
    login: string
    passwordHash: string
    hash?: string
    groups?: string[]
    disabled?: boolean
    fullName?: string              // your custom field
    department?: string             // ...
  }
}

const state = createDbState<Schema>({ tables: ["order"] })
state._user.load("u1").fullName    // ✅ typed
```

## Working with the change shape

If you build something on top of `applyChange` or process the log directly, import the `Change` type:

```ts
import type { Change } from "@db-state/core"

function logHandler(change: Change<Schema["order"]>) {
  if (change.action === "update" && change.set?.status === "closed") {
    notifyAdmin(change.userId, change.id)
  }
}
```

## Schema discriminated unions

A common pattern: orders that are either "draft" or "submitted" with different required fields.

```ts
type DraftOrder     = { _id: string; status: "draft"; items: Item[] }
type SubmittedOrder = { _id: string; status: "submitted"; submittedAt: string; items: Item[] }

type Schema = {
  order: DraftOrder | SubmittedOrder
}

const order = state.order.load("o1")
if (order.status === "submitted") {
  order.submittedAt   // ✅ narrowed
}
```

TS narrows the union normally on the reactive object.

## Custom socket events

```ts
state.socket.on("auth:expired", (msg) => { ... })
//                             ^ msg is typed as SocketMessage
state.socket.send("client:ready", { page: "orders" })
//                                 ^ payload is `unknown`
```

If you want stricter event typing, wrap in your own typed dispatcher:

```ts
type ClientEvents = {
  "client:ready": { page: string }
  "client:idle":  { since: number }
}

function send<K extends keyof ClientEvents>(type: K, payload: ClientEvents[K]) {
  state.socket.send(type, payload)
}

send("client:ready", { page: "orders" })  // ✅
send("client:ready", { foo: 1 })          // ❌
```

## Generic `Filter<T>` and helpers

Sometimes you want to pass filters around:

```ts
import type { Filter, ListQuery } from "@db-state/vue"

function buildOrderQuery(status: Schema["order"]["status"]): ListQuery<Schema["order"]> {
  return {
    filter: { status },
    sort: { createdAt: -1 },
    limit: 50
  }
}

state.order.listRef(buildOrderQuery("open"))
```

## TypeScript config

No special tsconfig needed. Anything that supports modern ESM should work:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",   // or "node16" if not using a bundler
    "strict": true,
    "esModuleInterop": true
  }
}
```

The published packages export their `.d.ts` via the `exports.types` field, so `moduleResolution: "bundler"` and `"node16"` both work out of the box.

## Verified examples

The library's own test file at [tmp/ts-check/sample.ts](../../../tmp/ts-check/sample.ts) is type-checked by `tsc --strict` as part of CI. If you find a case where the types feel weak or wrong, please open an issue with a minimal `.ts` reproduction.
