# Как это работает

> [English](../../en/architecture/how-it-works.md) · **Русский**

Эта страница объясняет общий поток данных, роли пакетов и причины основных архитектурных решений.

## Общая картина

```text
Vue 3 client
  state.order.listRef(...)
  state.order.update(...)
  IndexedDB cache
  reactive store
        |
        | WebSocket RPC + push
        v
Node server
  createDbStateServer
  CRUD, auth, permissions
  append-only log
        |
        v
MongoDB
  app tables
  log
  _user
  _group
```

Транспорт один: WebSocket. Через него идут библиотечные RPC (`load`, `sync`, `update`, `login`) и custom events приложения.

## Роли пакетов

### `@db-state/core`

Общий протокол без runtime-зависимостей: `Change`, `DB_STATE_MESSAGES`, `SERVICE_TABLES`, dot-path helpers, `applyChange`, `applyPatch`, фильтрация sync window.

### `@db-state/vue`

Браузерный клиент: reactive store, WebSocket facade, auth state, IndexedDB/Web Storage/memory cache, `load`, `idsRef`, `listRef`, `countRef`, mutation methods и sync loop.

### `@db-state/server-mongo`

Node-сервер: CRUD, auth, права по `access` групп, хуки, field projection, append-only log, WebSocket hub и broadcast `changes_available`.

### File modules

`@db-state/server-files` и `@db-state/vue-files` добавляют upload/download поверх того же WebSocket. JSON control-сообщения имеют prefix `dbfile:*`, бинарные чанки идут raw frames.

## Типичная запись end-to-end

1. Клиент вызывает `state.order.update({ id: "o1", set: { status: "closed" } })`.
2. Клиент отправляет WebSocket RPC `dbstate:rpc` с методом `update` и своим `sessionId`.
3. Сервер находит пользователя на socket и текущий документ.
4. Сервер проверяет `write` через хук `beforeWrite` и `user.access` (слитый из групп при логине).
5. Сервер применяет MongoDB update.
6. Сервер добавляет строку в `log`.
7. Сервер планирует broadcast `dbstate:changes_available`.
8. Автор получает `rpc_result` и применяет change локально.
9. Остальные клиенты получают wake-up, вызывают `sync()`, применяют видимые changes и обновляют cache/query refs.

## Cursor `time1`

Клиент хранит ISO timestamp последнего полностью примененного sync:

```js
state.sync.time1
```

Sync-запрос просит изменения `createdAt > time1` до серверного `to`. После успешного применения всего batch клиент записывает `to` как новый `time1`.

Если `time1` потерян, клиент стартует с `1970-01-01T00:00:00.000Z` и перечитывает весь log. Для больших логов нужны retention или snapshots.

## Подавление собственного эха через `sessionId`

Каждая вкладка получает свой `sessionId` в `sessionStorage`. Сервер записывает его в log, а `sync` исключает changes с тем же `sessionId`. Поэтому автор не применяет свою запись дважды, но другие вкладки того же пользователя получают изменение.

## Auth и socket

До `login`/`authByHash` обычный RPC отклоняется как unauthorized. После успешной авторизации socket содержит `client.user`, `client.userId`, `client.sessionId`, а все RPC проходят через permissions этого пользователя.

## Проверка прав во время sync

`user.access` уже висит на сокете (слит при логине), поэтому фильтрация sync-изменений не читает права из базы вовсе. `{}`-права решаются без чтения документов; фильтр строк проверяет сама база — один `findOne` на изменение сразу с фильтром; delete-изменения используют snapshot `old` из лога. Путь полностью декларативный: отдельной таблицы прав и построчного JS-fallback здесь нет.

## Почему append-only log

- Sync получает линейную историю изменений и может возобновиться после reconnect.
- Audit trail уже есть: кто, когда, какую таблицу и какой документ менял.
- Delete не требует tombstone в основной таблице: удаленный объект хранится в `change.old`.

## Почему только WebSocket

Нужен bidirectional transport: RPC, push-сигналы, login/auth и custom app events. HTTP можно оставить рядом для health checks, OAuth callback и публичных endpoints, но realtime-канал один.

## Почему нет optimistic concurrency control

Библиотека не добавляет `_v`, etag или compare-and-set. Для admin/B2B сценариев обычно достаточно diff-based saves, realtime обновлений формы и audit log. Для доменов со строгой транзакционностью используй отдельные domain operations с operation id.

## Почему нет schema/migrations слоя

db-state - транспорт и state/sync layer. Валидацию схемы лучше держать в Mongo JSON schema, Zod/Yup или доменном коде; миграции - отдельным инструментом вроде `migrate-mongo`.
