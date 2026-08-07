# Sync protocol

> [English](../../en/architecture/sync-protocol.md) · **Русский**

Эта страница описывает wire protocol синхронизации. Она полезна при отладке, написании нестандартного клиента или разборе пропущенных изменений.

## Cursor

У клиента один cursor:

```text
time1 = ISO timestamp последнего полностью примененного change
```

Начальное значение: `1970-01-01T00:00:00.000Z`. По умолчанию хранится в `localStorage` как `db-state.time1`.

## Sync window

`sync(from)` возвращает changes:

```text
createdAt > from
createdAt <= to
sessionId != callerSessionId
```

`to` — минимум из серверного времени и `from + 12 часов`. Клиент записывает `to` как новый `time1` только после успешного применения всех changes. При `hasMore: true` он сразу запрашивает следующее окно.

## RPC shape

Клиент:

```json
{
  "type": "dbstate:rpc",
  "id": "rpc1",
  "method": "sync",
  "payload": {
    "from": "2026-05-22T17:30:42.123Z",
    "sessionId": "u1_abcd"
  }
}
```

Сервер:

```json
{
  "type": "dbstate:rpc_result",
  "id": "rpc1",
  "result": {
    "to": "2026-05-22T17:30:42.456Z",
    "hasMore": true,
    "changes": []
  },
  "meta": {
    "fieldsFiltered": true
  }
}
```

`meta` optional и содержит только то, что серверу известно и так — ради него ничего не считается. `fieldsFiltered` означает, что действует белый список полей на чтение. Сколько строк или changes скрыли права, сервер не сообщает.

## Notifications

После записи сервер отправляет всем socket-клиентам:

```json
{ "type": "dbstate:changes_available" }
```

Это только wake-up. Клиент сам вызывает `syncNow()`, а сервер фильтрует результат по session и permissions.

## System events

| Event | Направление | Назначение |
|---|---|---|
| `dbstate:hello` | server -> client | Сервер готов после открытия socket. |
| `dbstate:changes_available` | server -> clients | Есть новые изменения, запусти sync. |
| `dbstate:force_resync` | server -> clients | Сбрось cursor и перечитай log. |
| `dbstate:error` | server -> client | Общая ошибка. |

## Auth handshake

Логин идет отдельным системным flow, не через `dbstate:rpc`:

```text
client -> { type: "dbstate:login", id, login, password }
server -> { type: "dbstate:login_result", id, ok, userId, hash, groups }
server -> { type: "dbstate:login_error", id, error }
```

Hash reconnect:

```text
client -> { type: "dbstate:auth", id, userId, hash }
server -> { type: "dbstate:auth_result", id, ok, userId, groups }
server -> { type: "dbstate:auth_error", id, error }
```

## Permission filtering в sync

Сервер не отдает все log rows вслепую. Для каждой записи он проверяет read access по таблице, пользователю и его группам, а хук `beforeRead` может решить раньше.

Field-level read rules фильтруют:

- `change.obj` для insert;
- `change.set` и `change.unset` для update;
- `change.old` для delete.

Если после field filtering update не содержит видимых полей, такое change можно скрыть полностью.

## Server clock

`to` формируется сервером. Все узлы, которые пишут в один log, должны иметь согласованные часы. Для одного Node-процесса этого достаточно; для multi-node deployment держи NTP и не допускай больших clock jumps.

### Clock drift

Если clock уехал назад, changes могут получить `createdAt` меньше уже выданного `to`. Для высоконагруженных систем лучше перейти к cursor continuation по `{ createdAt, _id }`.

## `_id` ordering

`_id` нужен как tie-breaker для записей с одинаковым `createdAt`. Текущая базовая модель использует timestamp window, но индекс `{ createdAt: 1, _id: 1 }` уже готовит путь к continuation cursor.

## Временные окна

Лимит задаётся временем, а не количеством строк:

- один response покрывает не более 12 часов;
- сервер обрабатывает все подходящие изменения внутри окна;
- `hasMore: true` запускает следующее 12-часовое окно;
- cursor старше 20 дней получает `{ reset: true, to, changes: [] }`.

При reset Vue-клиент очищает persistent и reactive cache, сохраняя авторизацию, перечитывает активные объекты/count/id queries и затем ещё раз синхронизируется от `to`.

## Echo suppression

Собственное изменение автор применяет из `rpc_result`. Поэтому sync исключает changes с тем же `sessionId`. Другая вкладка того же пользователя имеет другой `sessionId` и получит change.

## Force resync

`dbstate:force_resync` используется после bulk import, миграций или ручной правки log/cache. Клиент сбрасывает `time1`; сервер отвечает reset-маркером, после чего клиент очищает cache и перечитывает текущее состояние вместо воспроизведения всего журнала.

## Background safety sync

По умолчанию клиент не опрашивает сервер постоянно: он реагирует на `changes_available` и auth/reconnect events. Можно включить `safetySyncInterval`, если инфраструктура может терять wake-up сигналы.

## Отладка в браузере

Подпишись на envelopes:

```js
state.socket.on("dbstate:rpc_result", (message) => {
  console.log("RPC result", message)
})

state.socket.on("dbstate:rpc_error", (message) => {
  console.warn("RPC error", message)
})

state.onChange((change) => {
  console.log("Applied change", change)
})
```

Для типичных проблем смотри `state.sync.status`, `state.sync.time1`, `state.auth.status` и network frames.
