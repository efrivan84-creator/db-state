# @db-state/core

> [English](README.md) · **Русский**

Общий протокол, форма Change и dot-path хелперы для [db-state](https://github.com/efrivan84-creator/db-state). Без runtime-зависимостей.

В этом пакете нет зависимостей ни от Vue, ни от MongoDB. Он описывает общий язык, на котором разговаривают клиент и сервер.

## Что входит

- Константы протокола для `dbstate:*` сообщений.
- Нормализованная форма `Change`, которую используют CRUD, sync, cache updates и аудит.
- Dot-path хелперы для вложенных update-полей вроде `"profile.city"`.
- Patch-хелперы, которые применяют `set` / `unset` без замены всего объекта.
- Нормализация служебных таблиц: `_user`, `_group`, `_permission` всегда добавляются.
- Генерация session id и фильтрация sync-окна для подавления собственного эха.
- Нет runtime-зависимостей и привязки к браузеру или серверу.

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

### Группы экспортов

| Экспорт | Для чего нужен |
|---|---|
| `DB_STATE_EVENTS` | Зарезервированные события RPC, login, auth, sync notification и force-resync. |
| `SERVICE_TABLES` | Встроенные служебные таблицы: `_user`, `_group`, `_permission`. |
| `createChange` | Создаёт компактную нормализованную запись изменения. |
| `applyChange`, `applyPatch` | Применяют insert/update/delete изменения к локальным объектам. |
| `getByPath`, `setByPath`, `unsetByPath` | Читают и изменяют вложенные поля по dot-path. |
| `normalizeTables` | Добавляет служебные таблицы к списку таблиц приложения. |
| `createSessionId` | Создаёт id вкладки/сессии для подавления собственного эха. |
| `filterSyncChanges` | Фильтрует log-записи по `(from, to]` и исключает текущую session. |

## Правила

- `normalizeTables(tables)` добавляет `_user`, `_group` и `_permission`.
- `createdAt > time1 && createdAt <= time2` — окно sync.
- `sessionId` нужен, чтобы не присылать клиенту его же подтверждённые изменения.
- `set` поддерживает dot-path-поля типа `"profile.city"`.
- В `delete`-изменениях может лежать `old` для серверных проверок прав и аудита.
- `userId` идентифицирует автора, не копируя весь объект пользователя в каждую запись лога.
