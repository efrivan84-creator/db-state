# Changelog

Release notes and project status for db-state.

## Unreleased

## 0.0.12

- `@db-state/server-mongo`: `createDbStateServer({ methods })` registers custom named RPC methods in the same WebSocket router as the built-in CRUD/sync; modules (`files`) can contribute methods via a `methods` field, like `access` and `hooks`; a collision with a built-in method name throws at startup. `access`/`_permission` checks and the change log still apply only to the standard CRUD — a custom method that writes directly is responsible for its own permissions and audit.
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

- Realtime CRUD with permissions, offline cache, login, sync, and optional file transfer is implemented and covered by 77 tests.
- TypeScript declarations are included for all packages.
- Append-only log supports audit trail, delete recovery, and time-travel reconstruction patterns.
- Vue + MongoDB + WebSocket are the supported stack.

## Current limitations

- `_permission.if` currently supports equality-style matching. More operators such as `$in`, `$ne`, `$gte`, and dot-path user comparisons are planned.
- Permission filtering for list/count queries currently happens after Mongo reads the matching documents. Large datasets should add narrow app-level filters today; a server-side access prefilter hook is planned.
- Multi-document writes are not atomic yet. Use application/server-side code for workflows that must update several tables together; a `batch()`/transaction API is planned.
- Domain-specific server actions are not first-class yet. Custom socket events exist, but a request/response action layer is planned for operations such as chat message sending.
- File transfer v1 is not resumable after reconnect; an interrupted upload is marked `failed` and its temporary file is removed.
- The built-in file storage adapter is local filesystem storage. Use a custom `FileStorage` adapter for S3-compatible/object storage.
- The file module currently allows one active upload and one active download per socket to keep backpressure simple.
- Change wake-ups are debounced and rate-limited globally, but large deployments may still want per-table/per-client filtering or a custom broadcast layer.
- `syncLimit` should be high enough to fit one sync window. For very high write volume, add cursor continuation by `{ createdAt, logId }`.
- Offline writes are intentionally not queued. The client supports offline read, while writes require an online socket.
- React, Postgres, SQLite, and other adapters are not included.
