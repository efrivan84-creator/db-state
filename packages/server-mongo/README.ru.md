# @db-state/server-mongo

> [English](README.md) · **Русский**

Серверная часть для [db-state](https://github.com/efrivan84-creator/db-state) на MongoDB: CRUD, append-only лог, sync, WebSocket RPC, декларативные права доступа с правилами на уровне полей.

CRUD и sync доступны только через WebSocket RPC. HTTP-обработчиков в пакете нет.

## Что входит

- WebSocket RPC сервер для `load`, `getIds`, `getUnique`, `count`, `sync`, `add`, `update`, `remove`.
- Mongo-backed таблицы приложения плюс служебные `_user`, `_group`, `_permission`.
- Логин по паролю и reconnect по hash через тот же WebSocket.
- Append-only коллекция `log` для realtime sync, аудита, восстановления удалений и time-travel reconstruction.
- Sync по log-окнам `(time1, to]` с подавлением собственного session-эха.
- Проверка read/write прав для каждого RPC, включая служебные таблицы.
- Field-level права для чтения, sync-изменений, insert и update.
- Code access rules, которые могут переопределять или дополнять `_permission` и лениво грузить документы только когда это нужно.
- Встроенный socket hub и adapter hook для Redis/NATS-style broadcast в нескольких процессах.

## Установка

```sh
npm install @db-state/server-mongo mongodb ws
```

`mongodb` — опциональная peer-зависимость: подойдёт любой duck-typed `MongoDatabaseLike` (удобно для тестов с in-memory mongo).

## Подключение

```js
import { createDbStateServer } from "@db-state/server-mongo"

const dbState = createDbStateServer({
  mongo,
  tables: ["user", "order", "product"]
})
```

`_user`, `_group` и `_permission` добавляются автоматически. API о них знает, но доступ всё равно запрещён, пока его не разрешат code-правила или `_permission`.

Подключай WebSocket-клиентов из своего `ws`-сервера:

```js
dbState.socket.addClient(ws, {
  user: {
    _id: "u1",
    groups: ["manager"]
  },
  userId: "u1",
  sessionId: "u1_abcd"
})
```

## Обязательные индексы

В production создай:

```js
await mongo.collection("log").createIndex({ createdAt: 1, logId: 1 })
await mongo.collection("_permission").createIndex({ table: 1, priority: -1 })
```

Для запросов приложения добавляй обычные Mongo-индексы под `getIds`, `count`, `getUnique`:

```js
await mongo.collection("order").createIndex({ status: 1, createdAt: -1 })
```

## WebSocket RPC

Запрос клиента:

```js
{
  type: "dbstate:rpc",
  id: "rpc1",
  method: "update",
  payload: {
    table: "order",
    id: "o1",
    set: { status: "open" },
    sessionId: "u1_abcd"
  }
}
```

Ответ сервера:

```js
{
  type: "dbstate:rpc_result",
  id: "rpc1",
  result: { ok: true, change }
}
```

Поддерживаемые методы:

```js
load
getIds
getUnique
count
sync
update
add
remove
```

RPC отклоняется, пока сокет не авторизован.

### Кратко по методам

| Метод | Для чего |
|---|---|
| `load` | Читает один разрешённый документ с проекцией по `read.fields`. |
| `getIds` | Возвращает разрешённые id после `filter`, `sort`, `skip`, `limit`. |
| `getUnique` | Возвращает уникальные разрешённые значения одного поля. |
| `count` | Считает разрешённые документы по фильтру. |
| `sync` | Возвращает видимые log-изменения новее клиентского cursor. |
| `add` | Вставляет документ после проверки `write` и `write.fields`. |
| `update` | Применяет `set` / `unset` после проверки `write` и `write.fields`. |
| `remove` | Удаляет после document-level `write`; сохраняет удалённый объект в `change.old`. |

## Аутентификация

Пользователи живут в `_user`:

```js
{
  _id: "u1",
  login: "ivan",
  passwordHash: "...",
  hash: "auth-secret",
  groups: ["manager"],
  disabled: false
}
```

Запрос логина:

```js
{
  type: "dbstate:login",
  id: "login1",
  login: "ivan",
  password: "password"
}
```

Ответ:

```js
{
  type: "dbstate:login_result",
  id: "login1",
  ok: true,
  userId: "u1",
  hash: "auth-secret",
  groups: ["manager"]
}
```

`hash` переиспользуется между логинами. Вторая вкладка или устройство, логинящееся под тем же пользователем, получает существующий `_user.hash`; уже открытые вкладки не сбрасываются. Если `_user.hash` отсутствует, сервер создаст его при первом успешном логине.

Авторизация при реконнекте:

```js
{
  type: "dbstate:auth",
  id: "auth1",
  userId: "u1",
  hash: "auth-secret"
}
```

Logout на одном устройстве — локальный: клиент забывает `hash`.

Logout везде — ротация `_user.hash` на сервере.

Дефолтный адаптер паролей использует PBKDF2 из Node `crypto`. Можно заменить:

```js
createDbStateServer({
  mongo,
  tables,
  password: {
    hash: async (password) => "...",
    verify: async (password, passwordHash) => true
  }
})
```

## Таблица прав

По умолчанию доступ запрещён.

Сервер проверяет права в таком порядке:

1. Code-правило для `table + docId`.
2. Code-правило для `table`.
3. Правило в `_permission` с подходящими `table` и `if`.
4. Deny.

Документ права:

```js
{
  _id: "perm_order_open",
  table: "order",
  priority: 10,

  if: {
    status: "open"
  },

  read: {
    users: ["u1"],
    groups: ["manager"],
    action: true,
    fields: ["_id", "status", "total"]
  },

  write: {
    users: [],
    groups: ["admin"],
    action: true,
    fields: ["status", "comment"]
  }
}
```

Если `if` отсутствует — правило применяется ко всей таблице.

Если `action` отсутствует — подходящие пользователи/группы получают `true`.

Используй `action: false` для явного запрета.

Если `fields` отсутствует — разрешены все поля. Если `fields` задан:

- `read.fields` проецирует результат `load()`.
- `read.fields` также проецирует `insert`, `update` и `delete.old`-изменения, возвращаемые `sync()`.
- `write.fields` валидирует поля в `add()` и `update()`.
- `remove()` контролируется document-level `write`; для более строгого правила удаления используй code-правило с `action === "delete"`.

Запрещённые поля при записи отклоняют всю операцию.

## Code-правила доступа

Code-правила могут перебить базовые permissions:

```js
const dbState = createDbStateServer({
  mongo,
  tables: ["order"],
  access: {
    table: {
      order: {
        read: async ({ user, loadDoc }) => {
          const obj = await loadDoc()
          return obj.ownerId === user._id
        },
        write: async ({ user, obj, set }) => false
      }
    },
    doc: {
      order: {
        o1: {
          read: async () => true
        }
      }
    }
  }
})
```

Во время `sync()` изменённые документы подгружаются лениво. Если у `_permission`-правил для таблицы нет `if`, sync может решить вопрос доступа по `table + user/groups`, не читая изменённый документ. Code-правила, которым нужен документ, должны вызвать `ctx.loadDoc()` — это сделает Mongo `findOne` только когда правило действительно об этом просит.

`write` покрывает все мутирующие операции:

```text
insert
update
delete
```

Используй поле `action` в code-правилах, когда операция требует более строгого решения:

```js
const dbState = createDbStateServer({
  mongo,
  tables: ["order"],
  access: {
    table: {
      order: {
        write: async ({ action, user }) => {
          if (action === "insert") return true
          if (action === "update") return true
          if (action === "delete") return user.groups.includes("admin")
          return undefined
        }
      }
    }
  }
})
```

Возвращаемые значения:

- `true` — разрешить.
- `false` — запретить.
- `{ action: true, fields: ["status"] }` — разрешить с ограничением полей.
- `undefined` или `null` — без решения, передать на следующий слой.

## Логирование удалений

`remove()` сохраняет удалённый объект в `change.old`.

Это позволяет проверять права и вести аудит после того, как исходный документ исчез.

В каждой записи лога хранится id автора:

```js
{
  userId: "u1"
}
```

## Серверные поля info

Клиентские записи не могут выставлять или удалять поля `info`. При `add` сервер удаляет `info` из входного объекта и записывает:

```js
{
  info: {
    makeid: user._id,
    makedata: serverTime
  }
}
```

При `update` сервер удаляет `info` / `info.*` из клиентских `set` и `unset`, затем записывает:

```js
{
  "info.editid": user._id,
  "info.editdata": serverTime
}
```

Эти поля сохраняются в MongoDB и append-only log, поэтому клиент не может подделать create/edit metadata.

## Sync и audit log

Каждая успешная запись добавляет компактную строку в log:

```js
{
  logId,
  createdAt,
  table,
  id,
  action,      // insert | update | delete
  set,
  unset,
  obj,         // полный вставленный документ
  old,         // полный удалённый документ
  sessionId,
  userId
}
```

Клиенты вызывают `sync({ from, sessionId })`. Сервер читает `createdAt > from && createdAt <= to`, исключает session отправителя, применяет права на чтение, фильтрует запрещённые поля и возвращает `{ to, changes }`.

Для систем с большим числом записей держи `syncLimit` достаточно высоким для одного sync-окна или добавляй cursor continuation по `{ createdAt, logId }`.

## Полезные ссылки

- Полная документация: [docs/en](../../docs/en/README.md)
- Настройка сервера: [docs/en/server/setup.md](../../docs/en/server/setup.md)
- Права доступа: [docs/en/server/permissions.md](../../docs/en/server/permissions.md)
- Sync protocol: [docs/en/architecture/sync-protocol.md](../../docs/en/architecture/sync-protocol.md)

## Внутренние файлы

- `index.js` — CRUD, sync, запись в лог, публичная фабрика.
- `access.js` — code-правила и резолвинг `_permission`.
- `rpc.js` — диспатчер WebSocket RPC.
- `socket.js` — реестр WebSocket-клиентов и broadcast.
- `auth.js` — login/hash-аут и адаптер паролей.
