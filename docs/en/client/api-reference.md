# Client API reference

Complete reference for `@db-state/vue`. For deep-dive examples, follow the links in each section.

## Exports

```ts
import {
  createDbState,
  createIndexedDbCache,
  createMemoryCache,
  createStorageCache
} from "@db-state/vue"

// Types:
import type {
  DbState, DbStateOptions, DbStateSchema,
  TableApi, ReactiveDoc, ListQuery, Filter, SortSpec,
  UpdateArgs, MutationResult,
  DbStateCache, StorageLike, LoadingKeyRef,
  DbStateSocketFacade, SocketMessage,
  AuthResult, AuthStatus, SyncStatus, SyncState, AuthState,
  ServiceUser, ServiceGroup, ServicePermission, PermissionPart,
  BaseDoc, Change, ChangeAction
} from "@db-state/vue"
```

## `createDbState<TSchema>(options | tables)`

Returns a `DbState<TSchema>` instance — the reactive store.

```ts
createDbState<Schema>({
  tables: ["order", "product"],
  wsUrl: "wss://example.com/db-state/ws"
})

// Shortcut — equivalent to { tables }:
createDbState<Schema>(["order", "product"])
```

### `DbStateOptions<TSchema>`

| Option | Type | Default | Notes |
|---|---|---|---|
| `tables` | `string[]` | required | App tables. `_user`, `_group`, `_permission` added automatically. |
| `wsUrl` | `string` | `${ws-mapped origin}/db-state/ws` | WebSocket URL. |
| `autoConnect` | `boolean` | `true` | Open the socket immediately. |
| `autoAuth` | `boolean` | `true` | Try `authByHash` on socket open. |
| `cache` | `DbStateCache` | `createIndexedDbCache()` | Document cache backend. |
| `metaStorage` | `StorageLike` | `localStorage` | For `time1`. |
| `sessionStorage` | `StorageLike` | `sessionStorage` | For session id. |
| `authStorage` | `StorageLike` | `localStorage` | For saved `userId`/`hash`. |
| `sessionKey` | `string` | `"db-state.sessionId"` | Storage key. |
| `syncKey` | `string` | `"db-state.time1"` | Storage key. |
| `userIdKey` | `string` | `"db-state.userId"` | Storage key. |
| `authHashKey` | `string` | `"db-state.authHash"` | Storage key. |
| `userId` | `string` | — | Pre-seed user id (overrides `authStorage`). |
| `reconnectDelay` | `number` | `1000` | ms before WebSocket reconnect. |
| `rpcTimeout` | `number` | `15000` | ms for RPC waits. |
| `safetySyncInterval` | `number` | `30000` | Background sync interval. `0` = disabled. |
| `waitTimeout` | `number` | `15000` | `getAsync` timeout. |
| `countRefreshDelay` | `number` | `50` | Debounce for `countRef` refresh. |
| `idsRefreshDelay` | `number` | `50` | Debounce for `idsRef` refresh. |
| `onError` | `(err) => void` | `console.error` | Background error sink. |

## `DbState<TSchema>`

The reactive store. Spread of properties:

```ts
interface DbState<TSchema> {
  // Per-table accessors:
  [K in keyof Schema]: TableApi<TSchema[K]>

  sync: SyncState
  auth: AuthState
  socket: DbStateSocketFacade

  getKeyRef(key: string): LoadingKeyRef
  resetKey(key: string): void

  syncNow(): Promise<void>
  applyChange(change: Change): Promise<void>
  clearLocalDB(): Promise<void>

  login(login: string, password: string): Promise<AuthResult>
  authByHash(): Promise<boolean>
  autoAuth(): Promise<boolean>
  logout(): Promise<void>
}
```

### `sync: SyncState`

```ts
{
  connected: boolean       // is the WebSocket open right now
  sessionId: string        // per-tab session id
  status: "idle" | "syncing" | "error"
  time1: string            // ISO timestamp of last successful sync
}
```

### `auth: AuthState`

```ts
{
  userId: string | null
  hash: string | null
  status: "anonymous" | "authorizing" | "authorized" | "restored"
}
```

See [authentication.md](authentication.md#auth-states) for status semantics.

### `syncNow()`

Pulls the next batch of changes from the server and applies them. Idempotent — concurrent calls return the same promise.

```ts
await state.syncNow()
```

### `applyChange(change)`

Used internally and by tests. You generally don't call this directly.

```ts
await state.applyChange({
  logId: "...",
  table: "order",
  id: "o1",
  action: "update",
  set: { status: "closed" }
})
```

Updates the reactive store, writes/deletes cache row, schedules `countRef` / `idsRef` refresh.

### `clearLocalDB()`

```ts
await state.clearLocalDB()
```

Wipes:
- IndexedDB record cache
- `time1` from `metaStorage`
- Session id from `sessionStorage`
- In-memory reactive tables
- `countRef` / `idsRef` cached values

**Does not** touch auth — call `logout()` first if needed.

### `getKeyRef(key)` / `resetKey(key)`

Track combined loading state for a page-level key.

```ts
const loading = state.getKeyRef("orders-page")
// loading.value      = number of pending loads
// loading.ready.value = true when all are done

state.resetKey("orders-page")  // reset counter to 0
```

See [reactive-queries.md](reactive-queries.md#loading-keys).

## `TableApi<T>`

Returned by `state[tableName]`. Lazily created on first access.

```ts
interface TableApi<T extends BaseDoc> {
  readonly items: Record<string, ReactiveDoc<T>>
  readonly errors: Record<string, Error>

  load(id: string, key?: string): ReactiveDoc<T>
  load(id: null | undefined, key?: string): undefined

  getAsync(id: string, key?: string): Promise<ReactiveDoc<T> | undefined>

  getIds(query?: ListQuery<T>, key?: string): Promise<string[]>
  getUnique<V>(query: { field: string; filter?: Filter<T> }, key?: string): Promise<V[]>

  countRef(filter?: Filter<T>): Ref<number>
  idsRef(query?: ListQuery<T>): Ref<string[]>
  listRef(query?: ListQuery<T>, key?: string): ComputedRef<ReactiveDoc<T>[]>

  update(args: UpdateArgs<T>): Promise<MutationResult<T>>
  add(obj: Partial<T> & { _id?: string; id?: string }): Promise<MutationResult<T>>
  remove(id: string): Promise<MutationResult<T>>

  getError(id: string): Error | undefined
  isLoading(id: string): boolean
}
```

See [reactive-queries.md](reactive-queries.md) and [mutations.md](mutations.md) for deep dives.

## `ListQuery<T>`

```ts
interface ListQuery<T> {
  filter?: Filter<T>
  sort?: SortSpec<T>
  skip?: number
  limit?: number
}
```

- `filter`: Mongo-style equality matcher (`{ status: "open" }`). Operators like `$gt` work at runtime but aren't typed yet.
- `sort`: `{ field: 1 | -1 }`.
- `skip` / `limit`: standard pagination.

## `UpdateArgs<T>`

```ts
interface UpdateArgs<T> {
  id: string
  set?: Partial<T> & Record<string, unknown>      // overrides objedit
  objedit?: Partial<T> & Record<string, unknown>  // historical alias for set
  unset?: string[]
}
```

Dot-paths in `set` keys are valid: `"profile.city"` becomes Mongo `$set: { "profile.city": "..." }`.

## `MutationResult<T>`

```ts
interface MutationResult<T> {
  ok: true
  id?: string                  // for add: server-assigned id if not provided
  change: Change<T>            // the change appended to the log
}
```

## Socket facade — `state.socket`

```ts
interface DbStateSocketFacade {
  readonly raw: WebSocket | undefined
  connect(): void
  on(type: string, handler: (msg: SocketMessage) => void): () => void
  send(type: string, payload?: unknown): void
  rpc<T>(method: string, payload?: unknown): Promise<T>
  system<T>(type: string, payload?: object): Promise<T>
}
```

| Method | Purpose |
|---|---|
| `raw` | Underlying `WebSocket` for diagnostics. |
| `connect()` | Open if not already open/opening. |
| `on(type, fn)` | Subscribe to a message type. Returns disposer. |
| `send(type, payload)` | Send a custom event. Throws on `dbstate:*`. |
| `rpc(method, payload)` | Library RPC (not for app code). |
| `system(type, payload)` | Library system round-trip (login, auth, logout). |

See [socket.md](socket.md) for usage.

## Cache backends

```ts
createIndexedDbCache({ name?: string, store?: string }): DbStateCache
createStorageCache({ storage?: StorageLike, key?: string }): DbStateCache
createMemoryCache(): DbStateCache
```

Implement `DbStateCache` for custom backends:

```ts
interface DbStateCache {
  get<T>(table: string, id: string): Promise<T | undefined>
  set<T>(table: string, id: string, value: T): Promise<void>
  delete(table: string, id: string): Promise<void>
  clear(): Promise<void>
}
```

See [cache-and-offline.md](cache-and-offline.md).

## `ReactiveDoc<T>`

```ts
type ReactiveDoc<T> = T & { __loaded?: boolean }
```

A reactive proxy over your document. `__loaded` becomes `true` once data arrives from cache or server.

## Service table types

```ts
interface ServiceUser extends BaseDoc {
  login: string
  passwordHash: string
  hash?: string
  groups?: string[]
  disabled?: boolean
}

interface ServiceGroup extends BaseDoc {
  name?: string
}

interface ServicePermission<T = BaseDoc> extends BaseDoc {
  table: string
  priority?: number
  if?: Partial<T>
  read?: PermissionPart
  write?: PermissionPart
}

interface PermissionPart {
  groups?: string[]
  users?: string[]
  action?: boolean
  fields?: string[]
}
```

Override in your `Schema` if you have extra fields — see [typescript.md](typescript.md#service-tables).

## Core types (re-exported)

```ts
interface BaseDoc {
  _id: string
  id?: string
}

type ChangeAction = "insert" | "update" | "delete"

interface Change<T = BaseDoc> {
  logId: string
  createdAt: string
  table: string
  id: string
  action: ChangeAction
  set?: Partial<T> & Record<string, unknown>
  unset?: string[]
  obj?: T
  old?: T
  sessionId?: string
  userId?: string
}
```
