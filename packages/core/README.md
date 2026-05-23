# @db-state/core

> **English** · [Русский](README.ru.md)

Shared protocol, change shape and dot-path helpers for [db-state](https://github.com/efrivan84-creator/db-state). Zero runtime dependencies.

This package has no Vue or MongoDB dependency. It defines the common language used by the client and server.

## What you get

- Protocol constants for `dbstate:*` messages.
- The normalized `Change` shape used by CRUD, sync, cache updates, and audit.
- Dot-path helpers for nested update fields like `"profile.city"`.
- Patch helpers that apply `set` / `unset` updates without replacing the whole object.
- Service-table normalization: `_user`, `_group`, and `_permission` are always included.
- Session id creation and sync-window filtering for echo suppression.
- No runtime dependencies and no browser/server assumptions.

## Install

```sh
npm install @db-state/core
```

You normally don't install this directly — `@db-state/vue` and `@db-state/server-mongo` declare it as a dependency.

## Change Format

```js
{
  logId: "log1",
  createdAt: "2026-05-22T10:00:00.000Z",
  table: "user",
  id: "u1",
  action: "update", // insert | update | delete
  set: { fio: "Ivan" },
  unset: ["oldField"],
  obj: null,
  old: null,
  sessionId: "u1_abcd",
  userId: "u1"
}
```

## Exports

```js
import {
  DB_STATE_EVENTS,
  DB_STATE_MESSAGES,
  SERVICE_TABLES,
  applyChange,
  applyPatch,
  createChange,
  createSessionId,
  filterSyncChanges,
  getByPath,
  normalizeTables,
  setByPath,
  unsetByPath
} from "@db-state/core"
```

### Export groups

| Export | Purpose |
|---|---|
| `DB_STATE_EVENTS` | Backward-compatible subset of server push events: hello, changes available, force-resync, error. |
| `DB_STATE_MESSAGES` | Full reserved protocol/local message map for RPC, login, auth, logout, socket open/close, sync notification, and force-resync. |
| `SERVICE_TABLES` | Built-in service tables: `_user`, `_group`, `_permission`. |
| `BaseDoc`, `Change`, `Filter`, `SortSpec`, `ListQuery`, `UpdatePatch`, `UpdateArgs` | Shared document, change, query, and update TypeScript types. |
| `ServiceUser`, `ServiceGroup`, `ServicePermission`, `PermissionPart` | Shared service-table and permission TypeScript types. |
| `createChange` | Builds a compact normalized change record. |
| `applyChange`, `applyPatch` | Applies insert/update/delete changes to local objects. |
| `getByPath`, `setByPath`, `unsetByPath` | Reads and writes nested fields by dot path. |
| `normalizeTables` | Adds service tables to an app table list. |
| `createSessionId` | Creates a per-tab/session id for echo suppression. |
| `filterSyncChanges` | Filters log entries by `(from, to]` and skips the caller session. |

## Rules

- `normalizeTables(tables)` adds `_user`, `_group`, and `_permission`.
- `createdAt > time1 && createdAt <= time2` is the sync window.
- `sessionId` is used to avoid sending a client its own confirmed changes.
- `set` supports dot-path fields like `"profile.city"`.
- `delete` changes may include `old` for server-side permission checks and audit.
- `userId` identifies the actor without copying the whole user object into each log entry.
