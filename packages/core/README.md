# @db-state/core

> **English** · [Русский](README.ru.md)

Shared protocol, change shape and dot-path helpers for [db-state](https://github.com/efrivan84-creator/db-state). Zero runtime dependencies.

This package has no Vue or MongoDB dependency. It defines the common language used by the client and server.

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

## Rules

- `normalizeTables(tables)` adds `_user`, `_group`, and `_permission`.
- `createdAt > time1 && createdAt <= time2` is the sync window.
- `sessionId` is used to avoid sending a client its own confirmed changes.
- `set` supports dot-path fields like `"profile.city"`.
- `delete` changes may include `old` for server-side permission checks and audit.
- `userId` identifies the actor without copying the whole user object into each log entry.
