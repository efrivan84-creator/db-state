# Changelog

Release notes and project status for db-state.

## Unreleased

## 0.1.2

- Fixed: with `numericIds` the Vue client could not `load()` a document. The client normalizes an id to a string for its keys — reactive table, cache, loading marks — but the same string was also sent to the server, and Mongo does not match `"1"` against `_id: 1`, so the read silently returned nothing. The string is now used only as a key; the server and the document's own `_id` keep the original value. Same fix in `__retryUnloaded` and `resetRecord`, which rebuilt the id from the object key (always a string) and so lost the type on reconnect and on user switch.

## 0.1.1

- `createDbStateServer({ numericIds })` gives new documents a sequential integer `_id` — 1, 2, 3 — instead of a uuid. `true` covers every table, an array (`["order", "bill"]`) limits it to the listed ones; the default stays `false`, so nothing changes unless you opt in. Numbers come from a counter collection (`_counter`, one document per table, renamed via `counterCollection` and prefixed like the other service collections) through an atomic `$inc`, so concurrent writes never share a number — across processes too. An `_id` sent by the client is still used as-is and does not consume a number. Gaps are expected: the number is taken before the insert, so a failed or deleted write leaves a hole. Seeding a database by hand means seeding the counter too.

## 0.1.0

- **Breaking sync change:** `syncLimit` and the client-provided change limit are removed. Each server response covers at most 12 hours, `hasMore` makes the Vue client catch up through consecutive windows, and cursors older than 20 days return `reset: true` so the client clears its cache and reloads current state.
- `state.auth` now keeps who is signed in: `login`, `groups` and `access` are filled from the server response on `login()` / `authByHash()` and cleared on logout or a rejected hash. `login_result` / `auth_result` carry the user's `login` too, so an app can show the current user without an extra request.
- `applyChange` in `@db-state/core` now keys self-created records by `_id` instead of `id` — an `insert` without `obj` and an `update` for an unknown record used to produce a document that violated `BaseDoc`.
- `add` accepts a legacy `id` as the document key but no longer stores it alongside `_id`.
- `login_result` / `auth_result` report the field the user actually signed in with: with `authLoginFields: ["login", "email"]` a user who only has an `email` now gets `login: "ivan@example.com"` instead of nothing.
- **Breaking: reactive documents no longer mirror `_id` into `id`.** Every record was carrying the same value twice; the key is now `_id` only, as in Mongo and in the change log. Update templates that used `row.id` (`:key`, row selection) to `row._id`. An `id` passed to `add()` is still accepted as the document key, and `change.id` / `UpdateArgs.id` are unchanged — this only affects the document objects themselves.
- **Breaking: code access rules are removed.** `createDbStateServer({ access })` no longer exists — permissions live only in the `access` object of the user's groups, and dynamic decisions move to hooks. A `beforeRead`/`beforeWrite` hook may now return `false` or `{ allowed: false, reason }` to deny (the reason reaches the client), `true` to allow and skip the group check, or nothing to let the group access decide; `ctx` mutations apply either way. `beforeRead` can also set `ctx.fields` to narrow the returned fields (it can only narrow what `read_fields` allows). Because there are no code rules, the per-row fallback in `getIds`/`count`/`getUnique` is gone: access filters are always pushed into the Mongo query, so `skip`/`limit` always page over permitted rows. `AccessConfig`, `AccessRule`, `canAccess` and `filterReadable` are removed with it.
- **Breaking: hooks are declared once per name for the whole server.** Per-table nesting (`hooks: { order: { beforeRead } }`) is gone — branch on `ctx.table` inside the hook. Hooks contributed by mounted modules now run before the application hook of the same name instead of overwriting it, and the first explicit decision stops the chain.
- `errorRead` / `errorWrite` now also fire when the requested table is not in `tables`; previously that error was thrown before the hook could see it.
- `Read denied` / `Write denied` messages now name the table.
- `@db-state/server-files` no longer ships code rules: the file table is protected by its own hooks, `storageKey` never leaves the server on any CRUD read, and file metadata rights are configured as ordinary group `access`. Fixed a related bug where finishing an upload read the file back without the internal marker.
- **Breaking: `meta.accessFiltered` and `meta.denied` are removed.** How many rows or changes a read permission hid is no longer reported — the client has no use for it, and disclosing a count of inaccessible rows is itself a leak. The server no longer counts hidden rows, so the `getUnique`/`sync`/`count` paths lost their per-row bookkeeping. `meta.fieldsFiltered` stays: it is derived from the resolved permission without extra work. `meta` now reports only what the server already knows — nothing is counted or re-queried to fill it. `hasHiddenFields` and `hasHiddenChangeFields` are removed with it.
- A `read`/`write` value must be a filter object (or an array of them after group merge). Any other value — `true`, `1`, `false`, `""`, `[]` — is not a grant and denies access, so a typo or a stale record cannot silently widen permissions. `accessAllows` follows the same rule.
- Reads resolve the user once per request instead of once per `userReadPlan` call plus once per row, removing an N+1 for custom `getUser` implementations.
- A `read`/`write` value is always a document filter: `{}` = all rows (full access to the action), `{ enable: true }` = matching rows only; after group merge — an any-of array. `read_fields`/`write_fields` are field whitelists. The only flag is the special `fullaccess: 1` key. Filter placeholders: `"$adminid"` (the user's id) and `"$groupid"` (any of their groups) — "own documents" without any code. The `write` filter is checked against the existing document for `update`/`remove` and the new one for `add`; `sync` lazily loads the document only when a filter is present. Filters are evaluated by the database in a single query: lists and `count` get the access condition merged into the Mongo query (`count` via `countDocuments`, no row fetching), `sync` and `load` run one `findOne` that already includes the filter, `load` with `read_fields` gets only the allowed fields from Mongo (projection), `getIds` fetches only `_id`, and `"$groupid"` becomes `{ $in: groups }`. `accessAllows` accepts optional `doc`/`user`, `matchesAccessFilter` is exported.
- **Breaking: the `_permission` table is removed.** Permissions are now an `access` object on the group (`_group`): `{ zad: { read: {}, write: {} }, bill: { read: { needact: true } }, fullaccess: 1 }`. At login the server merges the `access` of all the user's groups (plus a personal `access` on `_user`) additively, attaches it as `user.access`, and returns it in `login_result`/`auth_result`. Check order: `beforeRead`/`beforeWrite` hook → `user.access` → deny. Declarative `read`/`write` filters control rows, while `read_fields`/`write_fields` control fields; hooks remain available for dynamic, external, or cross-document decisions. `read` covers `load/getIds/getUnique/count` and `sync` visibility; `write` covers `add/update/remove`. New exports: `accessAllows(access, table, action)`, `matchesAccessFilter`, and `mergeUserAccess`. This also removes the N+1 `_permission` lookup in `getIds`/`count` and the rules cache in `sync`.
- `@db-state/server-mongo`: `createDbStateServer({ methods })` registers custom named RPC methods in the same WebSocket router as the built-in CRUD/sync; modules (`files`) can contribute methods via a `methods` field, like `hooks`; a collision with a built-in method name throws at startup. Built-in access checks and the change log apply only to standard CRUD — a custom method that writes directly is responsible for its own permissions and audit.
- `@db-state/server-mongo`: `createDbStateServer({ methodsDir, methodsContext })` serves file-based RPC methods — `"zad.get-num"` maps to `<dir>/zad/get-num.js` (default export = handler). Files load lazily on first call and re-import when their mtime changes, so edits apply without a restart; name segments are validated so a client-supplied method name can never leave the directory; built-ins and `methods` take precedence. Every file method receives `db` and `api` by default; `methodsContext` spreads extras on top and can override them. `handleRpc` accepts an optional resolver as the 4th argument.

## 0.0.11

- Vue `login()` now resets already-returned reactive documents in place instead of deleting them from the table registry, so `load()` calls made before manual authorization keep their object identity, clear stale cached fields, and retry through `load` RPC after authorization.
- Added service collection prefix support: `createDbStateServer({ servicePrefix: "cfg" })` / `prefix` maps service collections to `cfg_user`, `cfg_group`, `cfg_permission`, and `cfg_log`; explicit `userTable`, `groupTable`, `permissionTable`, and `logCollection` options still override the derived names.
- Service tables are now exposed through CRUD/RPC only when explicitly listed in `tables`; server auth/permissions still use the configured service collections internally.
- `@db-state/server-files` and `@db-state/vue-files` now accept the same prefix for the default file metadata table (`cfg_file`), and file modules mounted through `createDbStateServer({ prefix, files })` inherit the server prefix unless they set an explicit `table`.
- Documentation now covers prefixed Mongo indices and the existing WebSocket port/path env pattern.

## 0.0.10

- Vue `login()` now starts from a clean client state: it clears local document/query cache and in-memory tables, moves `time1` to the current login moment, and does not run `syncNow()`.
- Hash auth / reconnect remains the sync path: `authByHash()` runs sync from the saved cursor and retries cache-missed reactive reads after authorization.
- `syncNow()` now applies the whole change batch first, collects unique changed tables, and refreshes `countRef` / `idsRef` once per changed table instead of once per change.
- Server writes without an authenticated user now use `systemUserId` (default `"system"`) for `info.makeid`, `info.editid`, and `change.userId` instead of writing an empty actor.
- Server RPC responses now include optional `meta.accessFiltered` / `meta.fieldsFiltered` / `meta.denied` when read permissions hide rows, sync changes, or object/change fields without changing the `result` shape.
- Vue socket RPC still resolves with `result`, but now also emits `dbstate:rpc_result` / `dbstate:rpc_error` envelopes to `state.socket.on(...)` for diagnostics.
- Documentation now describes the separate login-vs-restore flows and the batched query-ref refresh model.
- Added regression tests for login cache reset/no-sync behavior and batched query-ref refresh by changed table.

## 0.0.9

- Added optional `@db-state/server-files` and `@db-state/vue-files` packages for file upload/download over the same db-state WebSocket.
- Added server socket extension points for raw binary frames and async client-close cleanup handlers.
- `createDbStateServer({ files })` can mount file modules, auto-register their service tables, and merge their access/hooks into the server config.
- File metadata lives in the `file` table; binary download is gated by `token + downloadPolicy` (`public`, `registered`, `verified`, `groups`), and `storageKey` is never exposed to clients.
- `createFileClient(state)` registers `state.file`, supports upload/download progress callbacks, and lets file operations participate in `state.getKeyRef(key)`.

## 0.0.8

- Vue mutation methods `add`, `update`, and `remove` now accept an optional loading `key`, so writes can participate in `state.getKeyRef(key)` page/block loading counters.
- `state.getKeyRef(key)` now returns a reactive loading object with `value`, `max`, `start`, `percent`, and backward-compatible `ready`.
- Documentation now highlights `getKeyRef(key)` as both a page loading progress helper and a submitted-changes progress helper.
- Documentation now emphasizes that repeated `load(id, key)` calls for different document paths share one reactive object, one fetch, server-side in-place patches, and one page/form progress key.

## 0.0.7

- Simplified server code access rules to `access[table].read/write` and global `access.read/write`; removed the nested `access.table` / `access.doc` shape from docs and runtime lookup.
- Added a regression test for direct table and global code access rules.
- Added server lifecycle hooks: `beforeRead`, `afterRead`, `errorRead`, `beforeWrite`, `afterWrite`, and `errorWrite`, available globally and per table.

## 0.0.6

- Server `add` and `update` now strip client-supplied `info` / `info.*` fields before validation and persistence.
- Server `add` writes `info.makeid` and `info.makedata`; server `update` writes `info.editid` and `info.editdata` from the authorized user and server time.
- Added regression tests for server-owned create/edit metadata.
- Vue client now exposes `state.onChange`, table `onChange`, and filtered `onAdd` / `onEdit` / `onDelete` hooks after local changes are applied.

## 0.0.5

- Server auth can normalize login identifiers per configured field via `normalizeAuthLogin`, allowing lowercase emails and canonical phone values.
- Ambiguous normalized login matches are rejected with a generic auth error and reported through `onAuthWarning({ type: "ambiguous_auth_login", ... })`.
- Added `authRateLimit` hook for both login and hash-auth attempts.
- `@db-state/server-mongo` now exports `defaultPassword`, `defaultAuthHash`, `hashValue`, `createAuth`, `createHandlers`, `handleRpc`, and `createSocketHub` from the package root.

## 0.0.4

- Server change wake-ups are now debounced/rate-limited via `changesBroadcastDelay` and `changesBroadcastRate`, and signals are sent to every client including the writer.
- Client polling is disabled by default (`safetySyncInterval: 0`); sync now runs after authorization and on server signals.
- Server socket broadcasts can be rate-limited and cancelled when a newer database change supersedes an active wake-up wave.
- Documentation now describes signal-only sync and the scalable wake-up model.

## 0.0.3

- Protected server RPCs now wait for `state.auth.status === "authorized"`; cache-first reactive reads retry only missed loads after authorization.
- `sync` updates no longer create partial local documents; inserts still create documents from full log objects.
- Writes now wait up to `writeAuthTimeout` before failing when auth cannot be restored.
- `load()` now exposes `__cacheChecked` and keeps `__loaded = false` until cache/server data really arrives.
- One-off reads (`getAsync`, `getIds`, `getUnique`) now wait for authorization instead of failing before reconnect/auth restore.
- `@db-state/core` now owns the full `dbstate:*` message map plus shared service-table, permission, query, and update TypeScript types.
- Updated client README, API docs, auth docs, and reactive query docs for the new loading/auth flow.

## 0.0.2

- Added full `skip` support to `getIds`, `idsRef`, and `listRef` queries.
- Query deduplication now treats `skip` as part of the stable query key.
- Added tests for `getIds` pagination and `idsRef` deduplication with `skip`.
- Expanded English documentation:
  - architecture overview;
  - sync protocol;
  - change log model;
  - admin panel cookbook;
  - audit trail cookbook;
  - offline PWA cookbook;
  - advanced patterns.
- Updated README files to explain reactive database documents, reactive lists, reactive counters, sync, permissions, and offline read.

## 0.0.1

Initial public release:

- `@db-state/core`: shared protocol, change shape, dot-path helpers.
- `@db-state/vue`: Vue 3 client with reactive documents, `listRef`, `idsRef`, `countRef`, auth, sync, and IndexedDB cache.
- `@db-state/server-mongo`: MongoDB-backed WebSocket server with CRUD, append-only log, sync, auth, and permissions.

## Current status

- The `0.1.0` workspace contains five packages and is covered by 103 tests.
- Realtime CRUD with group-based access, offline cache, login, sync, custom methods, and optional file transfer is implemented.
- TypeScript declarations are included for all packages.
- Append-only log supports audit trail, delete recovery, and time-travel reconstruction patterns.
- Vue + MongoDB + WebSocket are the supported stack.

## Current limitations

- Declarative `access` filters have a portable equality-style contract with dot-path fields and the `"$adminid"` / `"$groupid"` placeholders. Use a `beforeRead` hook for dynamic, external, or cross-document predicates.
- Multi-document writes are not atomic yet. Use application/server-side code for workflows that must update several tables together; a `batch()`/transaction API is planned.
- Custom named methods and file-based methods are first-class RPCs, but direct database writes inside them do not automatically run built-in access checks or append to the db-state change log; hooks do not run for them either.
- File transfer v1 is not resumable after reconnect; an interrupted upload is marked `failed` and its temporary file is removed.
- The built-in file storage adapter is local filesystem storage. Use a custom `FileStorage` adapter for S3-compatible/object storage.
- The file module currently allows one active upload and one active download per socket to keep backpressure simple.
- Change wake-ups are debounced and rate-limited globally, but large deployments may still want per-table/per-client filtering or a custom broadcast layer.
- Sync processes every row in windows of at most 12 hours. Cursors older than 20 days trigger a client cache reset and current-state reload.
- Offline writes are intentionally not queued. The client supports offline read, while writes require an online socket.
- React, Postgres, SQLite, and other adapters are not included.
