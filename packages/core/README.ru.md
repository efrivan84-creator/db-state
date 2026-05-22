# @db-state/core

> [English](README.md) · **Русский**

Общий протокол, форма Change и dot-path хелперы для [db-state](https://github.com/efrivan84-creator/db-state). Без runtime-зависимостей.

В этом пакете нет зависимостей ни от Vue, ни от MongoDB. Он описывает общий язык, на котором разговаривают клиент и сервер.

## Установка

```sh
npm install @db-state/core
```

Обычно ставить напрямую не нужно — `@db-state/vue` и `@db-state/server-mongo` уже объявляют его в своих зависимостях.

## Формат Change

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

## Экспорты

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

## Правила

- `normalizeTables(tables)` добавляет `_user`, `_group` и `_permission`.
- `createdAt > time1 && createdAt <= time2` — окно sync.
- `sessionId` нужен, чтобы не присылать клиенту его же подтверждённые изменения.
- `set` поддерживает dot-path-поля типа `"profile.city"`.
- В `delete`-изменениях может лежать `old` для серверных проверок прав и аудита.
- `userId` идентифицирует автора, не копируя весь объект пользователя в каждую запись лога.
