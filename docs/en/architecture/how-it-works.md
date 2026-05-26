# How it works

This page explains the data flow from end to end, what each package does, and why the protocol looks the way it does.

## High-level picture

```
┌──────────────────────────┐                ┌──────────────────────────┐
│      Vue 3 client        │                │      Node server         │
│                          │                │                          │
│  state.order             │                │   createDbStateServer    │
│   .listRef(...)          │                │   ─ CRUD                 │
│   .update(...)           │  WebSocket     │   ─ Permissions          │
│   .login(...)            │ ◄────────────► │   ─ Append-only log      │
│                          │   RPC + push   │   ─ Broadcast            │
│   IndexedDB cache        │                │                          │
│   In-memory reactive     │                │   ┌──────────────────┐   │
│   store                  │                │   │   MongoDB        │   │
└──────────────────────────┘                │   │  - tables        │   │
                                            │   │  - log (append)  │   │
                                            │   │  - _user         │   │
                                            │   │  - _permission   │   │
                                            │   └──────────────────┘   │
                                            └──────────────────────────┘
```

Only one transport: WebSocket. Both **library RPC** (sync, CRUD, auth) and your **app events** share the same connection.

## Roles of the three packages

### `@db-state/core`

Pure protocol. Defines what a `Change` looks like, what dot-paths mean, what events are reserved. Used by both client and server. **Zero runtime dependencies.** ~4.2 KB source, ~1.2 KB min+gz.

Key exports:
- `Change<T>` shape — every write is one of these in the log.
- `applyChange(tables, change)` — applies a change to a `{ table → { id → doc } }` map in place.
- `applyPatch(target, change)` — applies set/unset to one document.
- `setByPath` / `getByPath` / `unsetByPath` — dot-path utilities.
- `DB_STATE_EVENTS` — reserved socket event names.
- `SERVICE_TABLES` — `["_user", "_group", "_permission"]`, added to every schema.

The client uses `applyPatch` when it receives a change. The server uses `createChange` when appending to the log. Both speak the same dialect.

### `@db-state/vue`

The browser client.

- **Reactive store**: `reactive({...})` from Vue, lazily populated per table.
- **Sync loop**: polls log via the `sync` RPC, applies returned changes.
- **WebSocket facade**: auto-reconnect, RPC correlation by id, system flow for login.
- **Cache backends**: IndexedDB, Web Storage, in-memory.
- **Query refs**: `idsRef` / `countRef` / `listRef` — deduplicated, persisted, refreshed on log changes.

### `@db-state/server-mongo`

The Node server.

- **CRUD methods**: `add` / `update` / `remove` / `load` / `getIds` / `getUnique` / `count`.
- **Permission layer**: code rules → `_permission` rows → deny.
- **Append-only log**: every write appended with `userId`, `set`, `unset`, full `old` for deletes.
- **WebSocket hub**: registers clients, broadcasts `changes_available`.
- **Auth**: PBKDF2 password adapter, hash-based reconnect.

## A typical write end-to-end

1. **Client**: `state.order.update({ id: "o1", set: { status: "closed" } })`.
2. **Client → server**: WebSocket frame `{ type: "dbstate:rpc", id: "rpc1", method: "update", payload: { table: "order", id: "o1", set: ..., sessionId: "u1_abcd" } }`.
3. **Server**: 
   1. Looks up the calling user via `getUser(req)`.
   2. Fetches current `order/o1` from Mongo for permission checks.
   3. Runs `assertAccess("write", ctx)`:
      - Tries `access.order.write` (your table-specific code rule, if any).
      - Tries `access.write` (your global code fallback, if any).
      - Reads `_permission` rows for `table: "order"`, sorted by priority, finds the first matching rule for this user.
      - Validates every dot-path in `set`/`unset` against `write.fields`.
   4. `mongo.collection("order").updateOne({ _id: "o1" }, { $set: ... })`.
   5. Appends to `log` collection: `{ logId, createdAt, table: "order", id: "o1", action: "update", set, unset, userId, sessionId }`.
   6. Schedules a debounced/rate-limited `{ type: "dbstate:changes_available" }` broadcast to all sockets, including the writer.
   7. Sends `{ type: "dbstate:rpc_result", id: "rpc1", result: { ok: true, change } }` back to the originator.
4. **Client (originator)**: receives `rpc_result`, runs `applyChange(change)` locally → reactive store and IndexedDB updated → `countRef`/`idsRef` for the table are debounce-scheduled for refresh.
5. **Other clients**: receive `dbstate:changes_available` → trigger `state.syncNow()` → server runs `sync(from=time1, sessionId=mine)` → returns changes (permission-filtered) → applies the whole batch → reactive store and IndexedDB updated → query refs refresh once per changed table.

Within ~50 ms of the originator's button click, every connected and authorized tab sees the new value in its `listRef`.

## The `time1` cursor

Each client tracks one ISO timestamp: `time1`. It's the upper bound of changes the client has already applied.

```js
state.sync.time1  // e.g. "2026-05-22T17:30:42.123Z"
```

Saved in `localStorage` (key: `db-state.time1` by default) so it survives page refreshes.

A `sync` call says "give me everything with `createdAt > time1`". The server returns `{ to: <now>, changes: [...] }`. The client applies them and writes `to` back as the new `time1`.

This makes sync **idempotent and resumable**:
- Disconnect for 5 minutes → reconnect → one `sync` call catches up.
- Server crash → client retries → same window, same result.
- Client loses all in-memory state but keeps `time1` → on next load, only the missed changes are replayed (everything before is already in IndexedDB).

If `time1` is lost (e.g. `clearLocalDB`), it resets to `1970-01-01T00:00:00.000Z` and the next sync replays the entire log. That's O(N) — fine for thousands of entries, painful for millions. For very large logs you might want a "max age" cutoff and a periodic snapshot mechanism (out of scope for the library).

## The `sessionId` echo suppression

Each tab gets a random `sessionId` (stored in `sessionStorage`, so per-tab).

When the client sends an RPC, it includes its `sessionId`. The server:
1. Writes the change to the log with that `sessionId`.
2. Broadcasts `changes_available` to all sockets. The writer may sync too; its own changes are filtered by `sessionId`.
3. During `sync`, filters out changes from the same `sessionId`.

Why? Because the originator already applied the change locally from the `rpc_result`. Receiving it again via sync would be redundant and could double-apply.

This means: **two tabs of the same user see each other's changes via sync**, because they have different `sessionId`s. Only the same tab is suppressed.

## Auth and the socket

The socket has three states from auth's perspective:

| State | What's set on the socket | What RPC can do |
|---|---|---|
| Anonymous | nothing | Reject all `dbstate:rpc` with `"Unauthorized"`. |
| Authenticated | `client.user`, `client.userId`, `client.sessionId` | All RPCs allowed; permissions apply per request. |

The socket is upgraded to authenticated via two paths:
- `dbstate:login` (login/password) — server verifies password, attaches user, returns `userId` + `hash`.
- `dbstate:auth` (hash reconnect) — server verifies hash matches `_user.hash`, attaches user.

Once authenticated, the socket stays that way until close or `dbstate:logout`. Subsequent RPCs reference `client.user` via the default `getUser`.

## The permission cache during sync

A naive `sync` would look like:

```js
for (const change of allChanges) {
  const rules = await mongo.collection("_permission").find({ table: change.table }).toArray()
  // ...
}
```

That's N Mongo round-trips per sync. The library does it once per table per call:

```js
const permissionRulesByTable = new Map()
// for each change:
const rules = permissionRulesByTable.get(table) ?? await fetchRules(table)
permissionRulesByTable.set(table, rules)
```

Same for the document load — only happens if a rule has `if` (and only then). For tables with no `if`-based rules, `sync` doesn't load any actual documents — it decides access from the change + user + permission rows alone.

## Why an append-only log?

Three reasons:

1. **Sync correctness**. To resume from any `time1`, you need an authoritative ordering of changes. An ad-hoc "send me what changed" approach can miss things during concurrent writes; a log gives you a single linearizable timeline.

2. **Audit trail and time-travel**. Every change has `userId`, `createdAt`, and (for deletes) the full pre-image. You can reconstruct any document's state at any past timestamp by replaying log entries — for free, no extra infrastructure.

3. **No tombstones in the main table**. Deletes are real Mongo deletes (table stays clean). The log captures what was deleted, so sync can still send "this id is gone" to clients without keeping zombie rows around.

The trade-off is that the log grows forever unless you prune. For most apps this is fine — millions of entries with the recommended index serve sync queries in milliseconds. For high-write workloads, prune entries older than (a) your longest-disconnected client and (b) your audit retention policy.

## Why WebSocket only?

Three reasons:

1. **Push without polling**. The whole point of "realtime" is server-initiated `changes_available`. HTTP doesn't allow this cleanly (long-polling is gross, SSE is one-way only).

2. **One connection, one protocol**. RPCs, system events (login), and app events all multiplex over the same socket. No CORS, no cookie scope issues, no second TCP handshake.

3. **Lower latency than HTTP**. A request/response over an established WebSocket is one round-trip; HTTP+TCP+TLS for each call is several.

The drawback: no caching of GETs by CDN, no native HTTP semantics. File transfer is covered by the optional `@db-state/server-files` / `@db-state/vue-files` modules over the same socket. For public APIs, OAuth callbacks, or curl-friendly health checks, run a separate HTTP server — see [server/setup.md](../server/setup.md#adding-http-endpoints).

## Why no optimistic concurrency control?

The library deliberately does **not** version documents or block concurrent writes (no `_v`, no etag, no compare-and-set). Reasons:

1. **The append-only log already provides correctness**. Even if two writes "race", both are in the log forever. The current state of the document is just the cumulative `$set` — there's no "lost data" in the audit sense.

2. **Field-level conflicts are rare**. With diff-based saves on the client (see [admin-panel cookbook](../cookbook/admin-panel.md#diff-based-saves)), two users editing different fields of the same document don't conflict. Both `$set`s land independently.

3. **Real conflicts are user-visible**. The realtime store updates the form as changes arrive. You typically see your colleague's change appear in the input before you save.

4. **Optimistic locking adds UI complexity**. Versioning requires a "stale version, refresh and try again" UI flow. For admin tools and B2B, that UX is worse than "last write wins on the same field, but the log keeps everything".

If your domain needs strict concurrency (e.g. financial transactions where a duplicate is unrecoverable), use a domain-level "operation id" pattern — record each business action with a unique id and reject duplicates server-side. That's orthogonal to db-state's job.

## Why no automatic schema or migrations?

By design. db-state is a transport — what your documents look like is your call. If you need:

- **Schema enforcement at the server**: add a Mongo JSON-schema validator on the collection.
- **Schema typing at the client**: use the TypeScript generic.
- **Migrations**: run them on your Mongo directly (e.g. with `migrate-mongo`). The library doesn't care; it just reads and writes documents.

Embedding a schema layer would have doubled the library's size and bound it to specific validation choices. The current Vue client is still only ~6.0 KB min+gz / ~5.4 KB brotli and does one thing well; schemas and migrations are well-served by existing tools.
