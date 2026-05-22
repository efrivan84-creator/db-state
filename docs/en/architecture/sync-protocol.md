# Sync protocol

The wire protocol for keeping clients in sync. If you're integrating a non-standard client or debugging sync issues, this is the page.

## Cursors

Each client maintains exactly one cursor:

```
time1 = ISO timestamp of the last successfully applied change
```

Initial value: `1970-01-01T00:00:00.000Z`. Persisted in `localStorage` as `db-state.time1` (configurable).

The server has its own clock — `config.now()` (default `new Date().toISOString()`).

## The sync window

`sync(from)` returns changes with:

```
createdAt > from        // exclusive lower bound
&& createdAt <= to      // inclusive upper bound
&& sessionId != caller  // skip the caller's own session
```

Where `to` is the server's clock at the moment of the call.

This guarantees:
- No change is returned twice (idempotent up to `time1` write).
- No change is missed across consecutive `sync` calls (assuming monotonic clock; see [Clock drift](#clock-drift)).
- The caller doesn't receive their own writes (suppressed by `sessionId`).

## RPC shape

Client → server:

```json
{
  "type": "dbstate:rpc",
  "id": "rpc-uuid",
  "method": "sync",
  "payload": {
    "from": "2026-05-22T17:30:42.123Z",
    "sessionId": "u123_abcdef",
    "limit": 1000
  }
}
```

Server → client:

```json
{
  "type": "dbstate:rpc_result",
  "id": "rpc-uuid",
  "result": {
    "to": "2026-05-22T17:30:42.456Z",
    "changes": [
      { "logId": "...", "createdAt": "...", "table": "order", "id": "o1", "action": "update", "set": { ... }, ... }
    ]
  }
}
```

The client applies changes in order to the reactive store, persists each affected document to cache, and writes `to` as the new `time1` only after the whole response has been processed. The UI can observe intermediate reactive updates while a large batch is being applied, but the stored cursor only advances after the batch is done.

## Notifications

The server pushes notifications to all sockets when changes happen:

```json
{
  "type": "dbstate:changes_available",
  "table": "order",
  "id": "o1",
  "to": "2026-05-22T17:30:42.456Z"
}
```

`table` and `id` are advisory — they tell the client which table was affected so it can decide whether to bother syncing. Currently the client always syncs on receipt (no per-table filtering); this is a planned optimization.

The originator socket is **excluded** by the broadcast's `excludeSessionId` option.

## System events

| Event | Direction | Purpose |
|---|---|---|
| `dbstate:hello` | server → client | First message after socket open. Tells the client the server is ready. |
| `dbstate:changes_available` | server → broadcast | Wake clients up for sync. |
| `dbstate:force_resync` | server → broadcast | Tell clients to reset `time1` and resync from scratch. |
| `dbstate:error` | server → client | Generic error. |

The client subscribes to these via `state.socket.on(...)`. `force_resync` is rarely used — most apps don't need it. Useful after a server-side bulk import where you'd rather everyone do one large sync instead of N small ones.

## Auth handshake

Login (one-shot RPC-like flow, not the normal RPC format):

```
client → { type: "dbstate:login", id: "msg1", login: "ivan", password: "..." }
server → { type: "dbstate:login_result", id: "msg1", ok: true, userId: "...", hash: "...", groups: [...] }
        // or:
server → { type: "dbstate:login_error",  id: "msg1", error: "Invalid login or password" }
```

Hash reconnect:

```
client → { type: "dbstate:auth", id: "msg2", userId: "...", hash: "..." }
server → { type: "dbstate:auth_result", id: "msg2", ok: true, userId, groups }
```

Logout:

```
client → { type: "dbstate:logout", id: "msg3" }
server → { type: "dbstate:logout_result", id: "msg3", ok: true }
```

These bypass the normal RPC dispatcher because they need to set up the socket's `user` attribute (which the RPC dispatcher then reads).

## Permission filtering in sync

The server iterates returned log entries and filters per request:

```js
for (const change of changes) {
  const access = await resolveAccess(config, "read", {
    req, table: change.table, id: change.id,
    obj: change.action === "delete" ? change.old : await maybeLoadDoc(),
    old: change.old, change, permissionRules: cachedRulesForTable
  })
  if (!access.allowed) continue
  const filtered = filterChangeFields(change, access.fields)
  if (filtered) result.push(filtered)
}
```

Optimisations:

1. `_permission` rows are cached **per sync call per table** — no N+1 lookup.
2. The current document is loaded lazily via `ctx.loadDoc()` — only if a rule actually calls it.
3. For tables with no `if`-based rules, document loading is skipped entirely; the rule can decide from `{ table, user, change }` alone.

Field filtering:

```js
function filterChangeFields(change, fields) {
  if (!fields) return change  // no whitelist = pass through

  if (change.action === "insert") {
    return { ...change, obj: projectFields(change.obj, fields) }
  }
  if (change.action === "delete") {
    return { ...change, old: projectFields(change.old, fields) }
  }
  if (change.action === "update") {
    const set = keep keys of change.set that are in fields
    const unset = keep entries of change.unset that are in fields
    if (set is empty && unset is empty) return undefined  // drop entirely
    return { ...change, set, unset }
  }
}
```

So a manager with `read.fields: ["status", "total"]` syncing an update that touched only `margin` gets **nothing** — that change is filtered out of the result.

## Server clock

`config.now()` returns ISO strings. The default uses `new Date()` — millisecond precision.

The library compares timestamps as strings (ISO 8601 sorts lexically). This works because ISO 8601 is lexicographically sortable iff the timezone is identical (default: UTC, since `toISOString()` always emits `Z`).

If you override `now`, return strings in the **same format** as the default — otherwise comparisons break.

### Clock drift

If two clients connect to two servers behind a load balancer, and the servers' clocks differ by more than the typical sync interval, you can get:

- Client A sees `time1 = T+100` from server X.
- Client A reconnects to server Y where `now() = T+50`.
- Sync window is `(T+100, T+50]` → empty → client thinks it's caught up but missed 50ms of changes from server X.

Fix: keep server clocks synced via NTP (typical drift on EC2/GCP: <10ms). For paranoid setups, use a single time-authority server (`now: () => fetchAuthoritativeTime()`).

## logId ordering

Two changes can share the same `createdAt` (millisecond precision). The library adds `logId` as a tiebreaker:

```js
.sort({ createdAt: 1, logId: 1 })
```

So the order is **deterministic** across sync calls: same `time1`, same `to` window → same change order.

`logId` is `crypto.randomUUID()` by default — UUIDs sort lexically, giving a stable order even for simultaneous changes from different sources.

## Limit handling

`sync(from, limit)` caps the response at `limit` entries (default 1000 from `config.syncLimit`).

The server still returns the `to` timestamp captured at the start of the call. Keep `syncLimit` high enough that one client can drain the expected amount of log traffic between sync calls. If more than `limit` visible changes exist inside one `(from, to]` window, advancing the client cursor to `to` would skip the overflowed entries.

For very busy systems, raise the limit (`createDbStateServer({ syncLimit: 5000 })`) or add cursor continuation before lowering it. A robust continuation cursor should include both `createdAt` and `logId`, because multiple log rows can share the same millisecond timestamp.

## Echo suppression: subtle case

When you do `state.order.update({ id, set })` from your tab:

1. Server stores the change with `sessionId: "yourTab"`.
2. Server broadcasts `changes_available` to all sockets except `yourTab`.
3. RPC returns `{ ok, change }` to yourTab; your tab does `applyChange(change)` locally.
4. Other tabs of you (different `sessionId`) receive the ping → sync → server returns the change (it's not filtered, since their `sessionId` differs).
5. They apply it.

Result: every tab is in sync. Your originating tab applied via RPC result; other tabs via sync.

But if your tab's `time1` was somehow stale (e.g. between RPC and applyChange the connection dropped and `time1` lost), the next sync would re-fetch your own change. The `sessionId` filter prevents this — even though you re-sync, your own session's changes are excluded.

## Force-resync flow

When the server emits `dbstate:force_resync`:

```js
state.socket.on(DB_STATE_EVENTS.forceResync, async () => {
  state.sync.time1 = "1970-01-01T00:00:00.000Z"
  await state.syncNow()
})
```

This pulls everything from the log. Expensive but useful after:
- A major data migration where you want fresh state on every client.
- Recovery from a malformed change that you've now patched server-side.

Use sparingly.

## Background safety sync

```js
if (options.safetySyncInterval > 0) {
  setInterval(() => {
    if (state.sync.connected) state.syncNow().catch(options.onError)
  }, options.safetySyncInterval)
}
```

Default 30 seconds. Catches:
- Missed `changes_available` notifications (rare but possible if a broadcast was inflight when the client reconnected).
- Server-side broadcast bugs.
- Cross-process scenarios where broadcast fan-out isn't fully wired.

For most apps this is invisible — it returns 0 changes and costs nothing.

## Inspecting sync in the browser

In dev tools console:

```js
state.sync.time1          // current cursor
state.sync.status         // "idle" | "syncing" | "error"
state.sync.connected      // boolean

state.socket.raw          // WebSocket object — readyState etc
```

To manually trigger a sync:

```js
await state.syncNow()
```

To reset and resync everything (useful in debugging):

```js
await state.clearLocalDB()  // wipes cache + time1
await state.login(...)      // forces fresh sync
```
