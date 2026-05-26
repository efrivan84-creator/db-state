# Server API reference

Complete reference for `@db-state/server-mongo`.

## Exports

```ts
import {
  createDbStateServer,
  defaultPassword,
  defaultAuthHash,
  hashValue,
  createAuth,
  createHandlers,
  handleRpc,
  createSocketHub
} from "@db-state/server-mongo"

// Types:
import type {
  DbStateServer, DbStateServerConfig,
  RequestContext, UpdateRequest, AddRequest, RemoveRequest,
  LoadRequest, ListRequest, UniqueRequest, CountRequest, SyncRequest,
  MutationResult, SyncResult,
  GetUserFn,
  MongoDatabaseLike, MongoCollectionLike, MongoCursorLike,
  AccessConfig, AccessContext, AccessDecision, AccessRule, AccessUser,
  ServerPermissionRule, PermissionPart,
  PasswordHasher, AuthHandlers, LoginMessage, AuthMessage, LogoutMessage,
  BroadcastOptions, ClientMeta, DetachClient, SocketAdapter, SocketClient, SocketHub,
  RpcHandler, RpcRequest, RpcRouter,
  BaseDoc, Change, ChangeAction
} from "@db-state/server-mongo"
```

## `createDbStateServer(config)`

Returns a `DbStateServer` instance with all CRUD methods and the socket hub.

```ts
createDbStateServer(config: DbStateServerConfig): DbStateServer
```

### `DbStateServerConfig`

| Option | Type | Default | Notes |
|---|---|---|---|
| `mongo` | `MongoDatabaseLike` | required | Mongo database handle. |
| `tables` | `string[]` | required | App tables. `_user`, `_group`, `_permission` added automatically. |
| `access` | `AccessConfig` | `{}` | Code access rules. |
| `hooks` | `ServerHooks` | `{}` | Lifecycle hooks around read/write operations. |
| `password` | `PasswordHasher` | PBKDF2 | Password hash adapter. |
| `authLoginFields` | `string[]` | `["login"]` | `_user` fields accepted by `dbstate:login`, e.g. `["login", "email", "phone"]`. |
| `normalizeAuthLogin` | `(value, field) => string` | `String(value).trim()` | Normalizes submitted login values before matching each configured field. |
| `authRateLimit` | `(ctx) => boolean \| void` | undefined | Optional login/hash-auth rate-limit hook. Return `false` to reject. |
| `onAuthWarning` | `(warning) => void` | undefined | Optional security warning hook, currently `ambiguous_auth_login`. |
| `createAuthHash` | `() => string` | 32 random hex | Auth-hash generator. |
| `createLogId` | `() => string` | `crypto.randomUUID()` | Log entry id generator. |
| `getUser` | `GetUserFn` | reads `req.client.user` | Resolve calling user. |
| `logCollection` | `string` | `"log"` | Log collection name. |
| `permissionTable` | `string` | `"_permission"` | Permissions collection. |
| `userTable` | `string` | `"_user"` | Users collection. |
| `systemUserId` | `string` | `"system"` | Actor id written to `info.makeid` / `info.editid` and `change.userId` for internal writes without an authenticated user. |
| `now` | `() => string` | `new Date().toISOString()` | Server clock. |
| `syncLimit` | `number` | `1000` | Max changes per sync call. |
| `changesBroadcastDelay` | `number` | `3000` | Debounce delay before waking clients after writes, ms. |
| `changesBroadcastRate` | `number` | `100` | Maximum clients to wake per second. |
| `socket` | `SocketAdapter` | undefined | Out-of-process broadcast hook. |

## `DbStateServer`

```ts
interface DbStateServer {
  socket: SocketHub

  add<T>(input: AddRequest<T>): Promise<MutationResult<T>>
  count<T>(input: CountRequest<T>): Promise<number>
  getIds<T>(input: ListRequest<T>): Promise<string[]>
  getUnique<T, V>(input: UniqueRequest<T>): Promise<V[]>
  load<T>(input: LoadRequest): Promise<T | null>
  remove<T>(input: RemoveRequest): Promise<MutationResult<T>>
  sync(input: SyncRequest): Promise<SyncResult>
  update<T>(input: UpdateRequest<T>): Promise<MutationResult<T>>
}
```

All CRUD methods accept the same shape (per their TS signatures). They run permission checks, hit Mongo, append to the log, and broadcast `changes_available`.

You can call them server-side directly:

```js
await dbState.add({
  table: "order",
  obj: { _id: "o1", status: "open", total: 100 },
  req: { client: { user: { _id: "u_system", groups: ["admin"] } } }
})
```

The `req` field tells the access layer who the caller is. For internal jobs, pass a system user.

### `add(input)`

```ts
interface AddRequest<T> {
  table: string
  obj: Partial<T> & { _id?: string; id?: string }
  sessionId?: string
  req?: unknown
}
```

Inserts the document. If `_id` is missing, the server generates one. Returns `{ ok, id, change }`.

### `update(input)`

```ts
interface UpdateRequest<T> {
  table: string
  id: string
  set?: Partial<T> & Record<string, unknown>
  unset?: string[]
  sessionId?: string
  req?: unknown
}
```

Mongo `$set` for `set`, `$unset` for `unset`. Upserts if the doc doesn't exist (so `update` works as "create or update").

### `remove(input)`

```ts
interface RemoveRequest {
  table: string
  id: string
  sessionId?: string
  req?: unknown
}
```

Deletes by `_id`. The full deleted document is captured in `change.old` for the log.

### `load(input)`

```ts
interface LoadRequest {
  table: string
  id: string
  req?: unknown
}
```

Returns the document (or `null`), projected to the readable fields per permission.

### `getIds(input)`

```ts
interface ListRequest<T> {
  table: string
  filter?: Partial<T> & Record<string, unknown>
  sort?: Record<string, 1 | -1>
  skip?: number
  limit?: number
  req?: unknown
}
```

Returns ids of documents matching `filter`, after applying `sort`, `skip`, `limit`, and permission filtering on each row.

### `getUnique(input)`

```ts
interface UniqueRequest<T> {
  table: string
  field: string
  filter?: Partial<T> & Record<string, unknown>
  req?: unknown
}
```

Returns distinct values of `field` across matching documents, after read permission filtering and field projection. If `field` isn't readable for the caller, returns `[]`.

### `count(input)`

```ts
interface CountRequest<T> {
  table: string
  filter?: Partial<T> & Record<string, unknown>
  req?: unknown
}
```

Returns the count after permission filtering. Note: this loads every matching document into memory to evaluate permissions, then counts. If you have millions of docs and need a `count` without per-row checks, write a custom handler that skips permission filtering.

### `sync(input)`

```ts
interface SyncRequest {
  from: string         // ISO timestamp (exclusive)
  sessionId?: string   // skip changes from this session
  limit?: number       // overrides config.syncLimit
  req?: unknown
}
```

Returns `{ to: string, changes: Change[] }`. The `to` is what the caller writes as the new `time1`. The `changes` array is permission-filtered.

## `socket: SocketHub`

```ts
interface SocketHub {
  addClient(client: SocketClient, meta?: ClientMeta): DetachClient
  broadcast(message: unknown, options?: BroadcastOptions): Promise<void>
  onConnection(handler: (client: SocketClient, meta: ClientMeta) => void): void
  handleConnection(client: SocketClient, meta?: ClientMeta): DetachClient
  handleMessage(client: SocketClient, raw: unknown): Promise<void>
  sendToUser(userId: string, type: string, payload?: unknown): void
}
```

| Method | Use |
|---|---|
| `addClient(ws, meta?)` | Register a connected WebSocket. Returns disposer. |
| `broadcast(msg, {rate, excludeSessionId})` | Send to clients, optionally rate-limited or excluding one session for app-level events. |
| `sendToUser(userId, type, payload)` | Send only to sockets matching `userId`. |
| `handleConnection` | Alternative entry point for adapters that route connection events themselves. |
| `handleMessage` | Manually inject a parsed message — used by tests and custom dispatchers. |

## `ClientMeta`

```ts
interface ClientMeta {
  user?: { _id: string; login?: string; groups?: string[] }
  userId?: string
  sessionId?: string
}
```

Whatever you pass becomes attributes on the `client` object. The library uses `userId` for `sendToUser` and `sessionId` for sync echo filtering. `user` is read by the default `getUser`.

## `PasswordHasher`

```ts
interface PasswordHasher {
  hash(plain: string): Promise<string> | string
  verify(plain: string, stored: string): Promise<boolean> | boolean
}
```

Default: `defaultPassword` (PBKDF2-SHA256, 120k rounds, 16-byte salt).

```ts
const defaultPassword: PasswordHasher
function defaultAuthHash(): string                // 32 random hex bytes
function hashValue(value: unknown): string        // SHA-256 hex of String(value)
```

`defaultPassword`, `defaultAuthHash`, and `hashValue` are runtime exports from the package root. Use them in public registration flows, seed scripts, tests, and app-level hashing needs.

## Access types

```ts
type AccessConfig = {
  read?: AccessRule<any>
  write?: AccessRule<any>
} & Record<string, { read?: AccessRule<any>; write?: AccessRule<any> } | AccessRule<any> | undefined>

type AccessRule<T> = (ctx: AccessContext<T>) => AccessDecisionValue | Promise<AccessDecisionValue>

type AccessDecisionValue =
  | boolean
  | { allowed: boolean; fields?: string[] }
  | { action: boolean; fields?: string[] }
  | { fields?: string[] }
  | null
  | undefined

interface AccessDecision {
  allowed: boolean
  fields?: string[]
}

interface AccessContext<T = BaseDoc> {
  req?: unknown
  user?: AccessUser
  table: string
  id: string
  docId: string
  obj?: T
  old?: T
  set?: Partial<T> & Record<string, unknown>
  unset?: string[]
  change?: Change<T>
  action?: "insert" | "update" | "delete"
  loadDoc?: () => Promise<T | undefined>
  permissionRules?: ServerPermissionRule<T>[]
}
```

See [code-access-rules.md](code-access-rules.md) for usage.

## Lifecycle hooks

`hooks` are lifecycle callbacks around server reads and writes. They are not permission rules: `access` decides allow/deny/fields, while hooks normalize input, add read prefilters, observe results, write side effects, and audit errors.

```ts
type ServerHooks =
  ServerHookSet &
  Record<string, ServerHookSet | ServerHook | undefined>

interface ServerHookSet<T = BaseDoc> {
  beforeRead?: ServerHook<T>
  afterRead?: ServerHook<T>
  errorRead?: ServerHook<T>
  beforeWrite?: ServerHook<T>
  afterWrite?: ServerHook<T>
  errorWrite?: ServerHook<T>
}

type ServerHook<T = BaseDoc> =
  (ctx: ServerHookContext<T>) => void | Promise<void>
```

Example:

```js
createDbStateServer({
  mongo,
  tables: ["order"],
  hooks: {
    beforeRead: async (ctx) => {
      ctx.filter = { ...ctx.filter, tenantId: ctx.user.tenantId }
    },
    order: {
      beforeWrite: async (ctx) => {
        if (ctx.action === "update") ctx.set.updatedBy = ctx.user._id
      },
      afterWrite: async ({ change }) => {
        // change is already written to the log.
      },
      errorWrite: async ({ error, method }) => {
        console.warn("write failed", method, error.message)
      }
    }
  }
})
```

### Hook lookup order

For table operations, the global hook runs first, then the table hook:

```text
hooks.beforeRead
  -> hooks[table].beforeRead
```

The same order applies to all hook names. For `sync`, there is no single table for the whole operation, so only global `beforeRead/afterRead/errorRead` run for the outer sync call. Per-change filtering still uses normal read access rules.

### Read order

For `load`:

```text
resolve user
beforeRead
Mongo findOne
access read
field projection
afterRead
return result
```

For `getIds`, `getUnique`, and `count`:

```text
resolve user
beforeRead
Mongo find(filter/sort/skip/limit)
per-row access read + field projection where needed
afterRead
return result
```

For `sync`:

```text
resolve user
beforeRead
read log window
for each change: access read + field filtering
afterRead
return { to, changes }
```

### Write order

For `add`:

```text
resolve user
strip client info
create server info.makeid/info.makedata
beforeWrite
access write
write.fields validation
Mongo insert
append log
schedule changes_available
afterWrite
return result
```

For `update`:

```text
resolve user
load old document
strip client info/info.*
create server info.editid/info.editdata
beforeWrite
apply patch for access ctx.obj
access write
write.fields validation
Mongo update
append log
schedule changes_available
afterWrite
return result
```

For `remove`:

```text
resolve user
load old document
beforeWrite
access write
Mongo delete
append log with change.old
schedule changes_available
afterWrite
return result
```

### Mutable fields

`beforeRead` may mutate request fields before Mongo reads:

```ts
ctx.filter
ctx.sort
ctx.skip
ctx.limit
ctx.field
ctx.from
ctx.sessionId
```

The main use is server-side prefiltering:

```js
hooks: {
  order: {
    beforeRead: async (ctx) => {
      ctx.filter = { ...ctx.filter, tenantId: ctx.user.tenantId }
    }
  }
}
```

`beforeWrite` may mutate write payloads before access checks and persistence:

```ts
ctx.obj       // add document
ctx.set       // update $set object
ctx.unset     // update unset paths
ctx.old       // loaded old document, normally read-only by convention
```

Do not mutate `ctx.clientObj`, `ctx.clientSet`, or `ctx.clientUnset`; they preserve the original client write for field-level validation.

`afterRead` and `afterWrite` receive `ctx.result`; `afterWrite` also receives `ctx.change`. They can mutate `ctx.result` before it is returned, but should usually be used for side effects.

### Errors

If any read step throws, `errorRead(ctx)` runs with `ctx.error`, then the original error is thrown to the caller.

If any write step throws, `errorWrite(ctx)` runs with `ctx.error`, then the original error is thrown to the caller.

Errors thrown inside `errorRead/errorWrite` are ignored so they do not hide the original failure. Errors thrown inside `before*` or `after*` become the operation failure and then trigger the matching error hook.

### Avoiding recursion

Hooks run inside `dbState.add/update/remove/load/getIds/getUnique/count/sync`. If a hook calls the same `dbState` method directly, that nested call runs hooks again. This is sometimes useful, but can recurse forever.

Avoid recursion by one of these patterns:

- Write side effects directly through `mongo.collection(...)` when they are internal audit/aggregate writes and do not need db-state sync.
- Use a guard flag on `ctx.req`, for example `req.internalHook === true`, and return early in the hook for nested calls.
- Use a separate system helper that bypasses the hook that triggered it.
- Keep `afterWrite` side effects idempotent, because a client may retry after an error.

Example guard:

```js
hooks: {
  order: {
    afterWrite: async (ctx) => {
      if (ctx.req?.internalHook) return

      await dbState.add({
        table: "audit",
        obj: { sourceTable: ctx.table, sourceId: ctx.id },
        req: { ...ctx.req, internalHook: true }
      })
    }
  },
  audit: {
    afterWrite: async (ctx) => {
      if (ctx.req?.internalHook) return
    }
  }
}
```

## Custom handlers

The RPC dispatcher is composed of two pieces — `createHandlers` builds the default router, `handleRpc` dispatches an incoming message into it.

```ts
function createHandlers(api: {
  add: RpcHandler; count: RpcHandler; getIds: RpcHandler; getUnique: RpcHandler
  load: RpcHandler; remove: RpcHandler; sync: RpcHandler; update: RpcHandler
}): RpcRouter

function handleRpc(
  router: RpcRouter,
  client: SocketClient,
  message: { id: string; method: string; payload?: unknown }
): Promise<void>
```

Default read handlers keep their normal `result` shape, but the `dbstate:rpc_result` envelope can include diagnostics: `meta.accessFiltered = true` and `meta.denied = N` when read permissions hide whole rows or log changes, plus `meta.fieldsFiltered = true` when read field whitelists remove object/change fields.

Wrap or extend for tracing, rate limiting, custom methods:

```js
import { createHandlers, handleRpc } from "@db-state/server-mongo"

const baseRouter = createHandlers(dbState)
const router = {
  ...baseRouter,
  "bulk-update": async (req) => {
    // your custom method
    return { ok: true, count: 5 }
  }
}

wss.on("connection", (ws) => {
  dbState.socket.addClient(ws)
  ws.on("message", async (raw) => {
    const msg = JSON.parse(String(raw))
    if (msg.type === "dbstate:rpc") {
      await handleRpc(router, ws, msg)  // overrides the default RPC handler
    }
  })
})
```

(The library's own message handler also runs — you'd need to disable it or accept that custom methods get tried twice. For a clean override, call `dbState.socket.addClient` with a custom socket adapter that intercepts before the library sees the message.)

## Mongo abstraction

```ts
interface MongoDatabaseLike {
  collection<T>(name: string): MongoCollectionLike<T>
  databaseName?: string
}

interface MongoCollectionLike<T> {
  findOne(filter?: object): Promise<T | null>
  find(filter?: object): MongoCursorLike<T>
  insertOne(doc: T): Promise<{ insertedId: unknown }>
  insertMany?(docs: T[]): Promise<{ insertedCount: number }>
  updateOne(filter: object, update: object, options?: { upsert?: boolean }): Promise<{ acknowledged: boolean }>
  deleteOne(filter: object): Promise<{ deletedCount: number }>
}

interface MongoCursorLike<T> {
  sort(spec: Record<string, 1 | -1>): MongoCursorLike<T>
  skip(count: number): MongoCursorLike<T>
  limit(count: number): MongoCursorLike<T>
  toArray(): Promise<T[]>
}
```

Anything satisfying these works — including the in-memory mock used by [demo/server/memoryMongo.js](../../../demo/server/memoryMongo.js).

For real Mongo: `npm install mongodb` and use `new MongoClient(uri).db("name")`.

## SyncResult

```ts
interface SyncResult {
  to: string                // ISO timestamp; client writes this as new time1
  changes: Change[]         // permission-filtered, ordered by createdAt + logId
}
```

The `to` is the **server's** current clock at the moment sync started. If the server's clock drifts, sync windows can briefly miss events — keep your servers reasonably time-synced (NTP).

## Performance limits

Approximate ceilings on commodity hardware (single Node, 4 vCPU, Mongo nearby):

| Metric | Approx ceiling |
|---|---|
| RPC throughput (load/update) | 2-5k ops/sec |
| Sync calls/sec | 500-1000 |
| Concurrent WebSocket clients | 5-10k per Node process |
| Broadcast amplification | Debounced and capped by `changesBroadcastRate` |

For higher throughput: shard by tenant, run multiple Node processes with sticky sessions, optimize Mongo indices.
