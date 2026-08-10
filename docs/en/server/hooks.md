# Server hooks

Hooks are where your application steps into the built-in CRUD/sync commands: rewrite the query, narrow the fields, allow or deny the operation, enrich the response.

Permissions themselves do not live here — they live in the `access` object of the user's groups, see [permissions](permissions.md). A hook is for decisions that depend on data a filter cannot express.

For the full call order see the [request flow map](../request-flow.md).

## Declaring hooks

Hooks are files in the `hooksDir` directory. The file name is the hook name, the folder is the table name:

```text
hooks/
  beforeRead.js          every table
  beforeWrite.js
  order/
    beforeRead.js        order only
    afterWrite.js
  bill/
    beforeWrite.js
```

```js
createDbStateServer({ mongo, tables: ["order", "bill"], hooksDir: "./hooks" })
```

Each file default-exports the hook:

```js
// hooks/order/beforeRead.js
export default (ctx) => {
  if (ctx.method === "getIds") ctx.limit = Math.min(ctx.limit || 200, 200)
}
```

There are six names: `beforeRead`, `afterRead`, `errorRead`, `beforeWrite`, `afterWrite`, `errorWrite`. Anything else in the directory is ignored, so a README or a helper module next to them breaks nothing.

Reads are `getIds`, `load`, `count`, `getUnique`, `sync`. Writes are `add`, `update`, `remove`. The exact command is always in `ctx.method`.

**Order:** the shared file first, then the table one. The first explicit decision (`true` or `false`) stops the chain. They share one `ctx`, so the table hook sees what the shared hook changed.

The configured directory must already exist and be readable. If it cannot be scanned, the operation fails instead of silently running without application hooks. Table folders may start with `_`, so service tables such as `_user` and `_group` work normally.

> A `hooks` object in the config is no longer accepted — the server throws `"hooks" is removed, use "hooksDir"` at startup. The same goes for `methods`: named RPC methods are declared only as files through `methodsDir`.

## Reloading files

The directory listing is read once on the first hook use; after that the server only touches the files it found and compares their `mtime` — but **at most once a minute**. Therefore:

- editing an existing file applies within a minute;
- adding or removing a file needs a restart; if a loaded file becomes unavailable, its last good handler stays active until then.

A hook is consulted on every operation, so hitting the disk before each call would cost more than the hook itself. The interval is set by `reloadCheckMs` (milliseconds); `0` checks `mtime` every time, which suits development:

```js
createDbStateServer({ mongo, tables, hooksDir: "./hooks", reloadCheckMs: 0 })
```

The same rule and the same option apply to method files in `methodsDir`.

## What to return

| Return | Effect |
| --- | --- |
| `undefined` (nothing) | No decision — the user's group access decides |
| `true` | Allowed; group access is skipped |
| `false` | Denied with the generic `Read denied: <table>` message |
| `{ allowed: false, reason: "..." }` | Denied; the reason is sent to the client |

Mutations of `ctx` apply **regardless** of the returned value. The common case is to rewrite the query and leave the decision to the group access:

```js
// hooks/beforeRead.js
export default (ctx) => {
  if (ctx.table !== "zad" || ctx.method !== "getIds") return
  ctx.filter = { $and: [ctx.filter ?? {}, { ownerId: ctx.user._id }] }
  // nothing returned → group access decides, but on the narrowed query
}
```

`afterWrite` cannot deny: it runs after the document, the change log and the broadcast are committed. Denial belongs in `beforeWrite`.

## Rewriting the query

`beforeRead` exposes the request fields; whatever you put there goes to the database:

```js
// hooks/beforeRead.js
export default (ctx) => {
  ctx.filter = sanitizeFilter(ctx.filter)         // getIds, count, getUnique
  if (ctx.method === "getIds") ctx.limit = Math.min(ctx.limit || 200, 200)
}
```

`ctx.fields` limits the returned fields and becomes a Mongo projection:

```js
// hooks/beforeRead.js
export default (ctx) => {
  if (ctx.table === "bill" && !ctx.user.groups.includes("boss")) {
    ctx.fields = ["fio", "balans"]
  }
}
```

A hook can only **narrow** fields; it cannot widen what the group's `read_fields` allows.

`beforeWrite` exposes `ctx.set` / `ctx.unset` (for `update`) and `ctx.obj` (for `add`):

```js
// hooks/beforeWrite.js
export default (ctx) => {
  if (ctx.method !== "update") return
  ctx.set.status = String(ctx.set.status).toLowerCase()
}
```

## Rewriting the response

```js
// hooks/afterRead.js
export default (ctx) => {
  if (ctx.method !== "load" || ctx.table !== "bill") return
  ctx.result = { ...ctx.result, canEdit: ctx.user.groups.includes("boss") }
}
```

## `ctx` contents

Always: `method`, `table`, `user`, `req` (`req.body` holds the client payload), `sessionId`, `db`, `api`.

Reads: `filter`, `sort`, `skip`, `limit`, `field`, `fields`, `id`, `obj`, `rows`, `result`.

Writes: `id`, `obj`, `old`, `set`, `unset`, `action`, `actorId`, `now`, `change`, `result`.

`db` and `api` let a hook read and write, not just decide the request's fate. `db` is the Mongo driver — no permission checks, no change log. `api` runs the same commands the client does, with permissions, the change log and the `changes_available` broadcast.

Writing to the same table from `afterWrite` re-enters the hook. Break the loop with a marker in `req`:

```js
// hooks/bill/afterWrite.js
export default async (ctx) => {
  if (ctx.req?.internal) return
  await ctx.api.update({ table: "bill", id: ctx.id, set: { seen: true }, req: { ...ctx.req, internal: true } })
}
```

`errorRead` / `errorWrite` also get `ctx.error`. An exception thrown inside an error hook is swallowed so the original error stays authoritative.

## Examples

### Deny with a clear reason

```js
// hooks/beforeWrite.js
export default (ctx) => {
  if (ctx.method === "remove" && ctx.table === "bill") {
    return { allowed: false, reason: "Contracts are archived, not deleted" }
  }
}
```

### System operations without permissions

```js
// hooks/beforeWrite.js
export default (ctx) => {
  if (ctx.req?.__internal) return true
}
```

### Audit

```js
// hooks/afterWrite.js
export default (ctx) => {
  audit.push({ who: ctx.actorId, what: ctx.method, table: ctx.table, id: ctx.id })
}
```

### Logging denials

```js
// hooks/errorRead.js
export default (ctx) => {
  console.warn(`${ctx.method} ${ctx.table}: ${ctx.error.message}`)
}
```

## Module hooks

Mounted modules (such as `@db-state/server-files`) declare their own hooks. This is the module's internals: that is how it protects its own table and lets its own internal calls through.

They run **before** the application's file hooks of the same name, and the first explicit decision (`true` or `false`) stops the chain. They do not need to be — and should not be — restated in `hooksDir`; they travel with the module.

Part of the same is expressible as group permissions: `read_fields` on the file table hides service fields without any hook. The hook is for what a filter cannot express.

## Where to put what

| Task | Where |
| --- | --- |
| "own documents", "own group", "active only" | Filter in the group access (`$adminid`, `$groupid`) |
| A fixed list of visible fields per role | `read_fields` in the group access |
| Condition depends on time, request params, another table | `beforeRead` / `beforeWrite` |
| Clamping and sanitising the client filter | `beforeRead` |
| A hard denial with a message | `beforeRead` / `beforeWrite` |
| Enrich the response | `afterRead` |
| Audit and metrics | `afterWrite` |

Anything expressible as a filter belongs in the group access: it goes straight into the database query, is edited by an administrator, and needs no restart.

## See also

- [Request flow map](../request-flow.md)
- [Permissions](permissions.md)
- [Server API reference](api-reference.md)
