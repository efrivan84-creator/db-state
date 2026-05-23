# Changelog

Release notes and project status for db-state.

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

- Realtime CRUD with permissions, offline cache, login, and sync is implemented and covered by 50 tests.
- TypeScript declarations are included for all packages.
- Append-only log supports audit trail, delete recovery, and time-travel reconstruction patterns.
- Vue + MongoDB + WebSocket are the supported stack.

## Current limitations

- `_permission.if` currently supports equality-style matching. More operators such as `$in`, `$ne`, `$gte`, and dot-path user comparisons are planned.
- Change wake-ups are debounced and rate-limited globally, but large deployments may still want per-table/per-client filtering or a custom broadcast layer.
- `syncLimit` should be high enough to fit one sync window. For very high write volume, add cursor continuation by `{ createdAt, logId }`.
- Offline writes are intentionally not queued. The client supports offline read, while writes require an online socket.
- React, Postgres, SQLite, and other adapters are not included.
