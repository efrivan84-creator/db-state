# @db-state/server-mongo

> [English](README.md) · **Русский**

Серверная часть для [db-state](https://github.com/efrivan84-creator/db-state) на MongoDB: CRUD, append-only лог, sync, WebSocket RPC, права по группам (объект `access`) с фильтрами строк и списками полей, плюс хуки.

CRUD и sync доступны только через WebSocket RPC. HTTP-обработчиков в пакете нет.

## Что входит

- WebSocket RPC сервер для `load`, `getIds`, `getUnique`, `count`, `sync`, `add`, `update`, `remove`.
- Mongo-backed таблицы приложения плюс служебные `_user` и `_group`.
- Логин по паролю и reconnect по hash через тот же WebSocket.
- Append-only коллекция `log` для realtime sync, аудита, восстановления удалений и time-travel reconstruction.
- Sync по log-окнам `(time1, to]` с подавлением собственного session-эха.
- Проверка read/write прав для каждого RPC по объекту `access` групп пользователя; фильтры строк уходят прямо в Mongo-запрос.
- Field-level права для чтения, sync-изменений, insert и update.
- Хуки вокруг каждого чтения и записи: правка запроса, ограничение полей, разрешение и запрет с причиной, аудит ошибок.
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

`_user` и `_group` не открываются через CRUD/RPC автоматически. Добавь их в `tables` явно, если они нужны админке; доступ всё равно запрещён, пока его не разрешит хук или `access` групп.

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
await mongo.collection("log").createIndex({ createdAt: 1, _id: 1 })
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
  result: { ok: true, change },
  meta: { fieldsFiltered: true } // optional
}
```

В `meta` попадает только то, что серверу и так известно — ради него ничего не считается и не перезапрашивается. `fieldsFiltered: true` означает, что действует белый список полей на чтение, поэтому набор возвращённых полей ограничен. Сколько строк или изменений скрыли права чтения, сервер не сообщает: клиенту это не нужно, а подсчёт стоил бы лишнего запроса. Обычная форма `result` не меняется.

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
| `load` | Читает один разрешённый документ с проекцией по `read_fields`. |
| `getIds` | Возвращает разрешённые id после `filter`, `sort`, `skip`, `limit`. |
| `getUnique` | Возвращает уникальные разрешённые значения одного поля. |
| `count` | Считает разрешённые документы по фильтру. |
| `sync` | Возвращает видимые log-изменения новее клиентского cursor. |
| `add` | Вставляет документ после проверки `write` и `write_fields`. |
| `update` | Применяет `set` / `unset` после проверки `write` и `write_fields`. |
| `remove` | Удаляет после document-level `write`; сохраняет удалённый объект в `change.old`. |

Для read RPC WebSocket envelope `dbstate:rpc_result` может содержать `meta.fieldsFiltered = true` без изменения `result` — значит, действуют field-level правила чтения и набор полей ограничен. Скрытые строки не разглашаются.

## Свои RPC-методы

Кроме стандартных CRUD/sync именованные серверные методы объявляются файлами в `methodsDir` — имя метода становится путём к файлу.

### `methodsDir`

Вместо регистрации можно отдать папку — имя метода само превращается в путь к файлу:

```js
const dbState = createDbStateServer({
  mongo,
  tables: ["zad"],
  methodsDir: import.meta.dirname + "/rpc"
})
```

`methodsDir` принимает путь-строку или file-URL. Относительный путь вида `"./rpc"`
резолвится от cwd процесса — надёжнее привязываться к модулю через `import.meta.dirname`.

`"zad.get-num"` → `rpc/zad/get-num.js`, файл экспортирует обработчик по умолчанию:

```js
// rpc/zad/get-num.js
export default async ({ body, user, db }) => {
  const [last] = await db.collection("zad").find({}).sort({ num: -1 }).limit(1).toArray()
  return { num: (last?.num ?? 0) + 1 }
}
```

- Файл читается лениво при первом вызове и **перечитывается, если изменился mtime** — правки применяются без перезапуска сервера.
- Каждый файловый метод по умолчанию получает `db` (Mongo этого сервера), `api` (сам db-state сервер: `api.add`/`api.update` пишут с логом и broadcast) и `user` (из `client.user`). Нужно больше — `methodsContext: {...}` добавляет своё поверх (одноимённые ключи переопределяют дефолты).
- Сегменты имени валидируются (`[a-z0-9_-]`, разделитель — точка): имя от клиента не может выйти за пределы папки.
- Встроенные методы и `methods` имеют приоритет; файл проверяется последним.
- Перезагрузка использует `import` с `?v=mtime`: старые копии модуля остаются в памяти (ESM не выгружается). В бою файлы не меняются, в разработке это незаметно; обработчики не должны хранить состояние на уровне модуля.

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
  groups: ["manager"],
  access: { order: { read: {} } }
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

## Права: `access` на группах

По умолчанию доступ запрещён.

Права хранятся как данные на группе (`_group`), объект произвольной вложенности:

```js
{
  _id: "montaj",
  name: "Монтажники",
  access: {
    zad: { read: {}, write: {} },    // полный доступ к таблице ({} = все строки)
    bill: { read: {} },              // только чтение, все строки и поля
    admin: {
      read: { enable: true },        // фильтр: видны только совпавшие документы
      read_fields: ["fio", "tel"],   // и только эти поля
      write: {},                     // {} = редактировать любые строки
      write_fields: ["tel"]          //   но менять только эти поля
    },
    fullaccess: 1                    // спецключ: доступ ко всему
  }
}
```

При логине сервер сливает `access` всех групп пользователя (плюс личный
`access` на самом `_user`, если есть) и вешает результат на `user.access`.
Слияние только аддитивное, запретов нет: фильтры разных групп складываются
в any-of, `{}` (все строки) шире любого фильтра.
Объект возвращается в `login_result`/`auth_result` — клиент может прятать
разделы UI без запросов. Изменение прав группы применяется при следующем
логине или reconnect.

Сервер проверяет права в таком порядке:

1. Хуки подключённых модулей.
2. Общий, затем табличный хук приложения из `hooksDir`.
3. Если хук не принял решение — `user.access`: `fullaccess`, затем фильтр `<table>.<action>`.
4. Deny.

Маппинг действий: `read` — `load`, `getIds`, `getUnique`, `count` и видимость
изменений в `sync`; `write` — `add`, `update`, `remove`.

### Фильтры и поля

Значение `read`/`write` — **фильтр по документу** (dot-пути): `{}` совпадает
со всем, то есть даёт действие на всю таблицу; после слияния групп может быть
массив фильтров (документ подходит, если совпал хотя бы один).

Подстановки в значениях фильтра:

- `"$adminid"` — id текущего пользователя;
- `"$groupid"` — совпадение с любой из его групп.

```js
{ zad: { read: { master: "$adminid" } } }   // техник видит только свои заявки
{ zad: { read: { dep: "$groupid" } } }      // отдел видит заявки своего участка
```

`write`-фильтр проверяется по **существующему** документу для `update`/`remove`
и по **новому** — для `add`. `read_fields`/`write_fields` — белые списки полей:
чтение проецирует документы и sync-изменения, запись отклоняет чужие пути.
При слиянии групп поля объединяются, а право без ограничения полей снимает
ограничение целиком.

**Фильтры проверяет сама база, одним запросом:**

- списки (`getIds`, `count`, `getUnique`) добавляют фильтр права прямо
  в условие Mongo (`$or` при нескольких), база возвращает только разрешённые
  строки, а `getIds` запрашивает только `_id` (projection); `count` при этом
  использует `countDocuments` без выгрузки данных;
- `load` проверяет фильтр права тем же `findOne`, а при `read_fields` просит
  у Mongo только разрешённые поля (projection); `getUnique` — только нужное поле;
- `sync` для изменённого документа делает один `findOne` сразу с фильтром права;
- `{}`-права решаются вообще без обращения к базе;
- `"$groupid"` в запросе превращается в `{ $in: группы }`.

Проверить объект вручную (например, в именованном методе):

```js
import { accessAllows } from "@db-state/server-mongo"

accessAllows(user.access, "bill", "write")            // есть ли доступ в принципе
accessAllows(user.access, "zad", "read", doc, user)   // проверить конкретный документ
```

Условия по строкам и ограничения полей задаются декларативными `read` /
`write` и `read_fields` / `write_fields`. Файловые хуки нужны для динамических
решений, которые нельзя выразить такими фильтрами.

## Хуки

Хуки — точки, где приложение вмешивается в стандартные команды: правит запрос,
ограничивает поля, разрешает или запрещает, дополняет ответ.

```js
const dbState = createDbStateServer({ mongo, tables: ["order"], hooksDir: "./hooks" })
```

```js
// hooks/beforeRead.js — общий префильтр для всех таблиц
export default (ctx) => {
  ctx.filter = { ...ctx.filter, tenantId: ctx.user.tenantId }
}

// hooks/order/beforeWrite.js — только для таблицы order
export default (ctx) => {
  if (ctx.method === "remove" && !ctx.user.groups.includes("admin")) {
    return { allowed: false, reason: "Удалять заказы может только администратор" }
  }
  if (ctx.method === "update") ctx.set.updatedBy = ctx.user._id
}
```

Имена хуков:

```text
beforeRead   afterRead   errorRead
beforeWrite  afterWrite  errorWrite
```

Файл в корне действует на все таблицы, файл в подпапке — только на свою;
общий выполняется первым. Файлы сверяются с mtime не чаще `reloadCheckMs`
(по умолчанию 60 с), поэтому правка применяется без перезапуска.
Добавление или удаление файла требует перезапуска; если загруженный файл стал
недоступен, продолжает работать его последняя успешная версия.
Явно заданная папка `hooksDir` должна существовать и читаться; имя подпапки
таблицы может начинаться с `_`, например `_user`.

### Что возвращать

| Возврат | Что происходит |
| --- | --- |
| `undefined` | Решения нет — дальше проверяются права группы |
| `true` | Разрешено, права группы не проверяются |
| `false` | Запрет, сообщение `Read denied: <таблица>` |
| `{ allowed: false, reason }` | Запрет, причина уходит клиенту |

Изменения `ctx` применяются всегда, независимо от возврата: можно поправить
запрос и оставить решение правам группы.

`beforeRead` меняет `ctx.filter`, `ctx.sort`, `ctx.skip`, `ctx.limit` и
`ctx.fields` (проекция полей) до обращения к Mongo. `beforeWrite` меняет
`ctx.obj`, `ctx.set`, `ctx.unset` до проверки прав и сохранения.

`afterWrite` вызывается после записи в Mongo, дозаписи лога и рассылки —
запретить оттуда уже нельзя, доступны `ctx.change` и `ctx.result`.

Каждый хук получает `ctx.db` — Mongo напрямую — и `ctx.api` — CRUD/sync API
этого сервера. Используйте `db` для служебных данных мимо прав и журнала,
а `api` — когда вложенная запись должна пройти обычные права, попасть в журнал
и разбудить клиентов. Вызов `api` из `afterWrite` для той же таблицы снова
входит в хук, поэтому передавайте метку в `req` и выходите на вложенном вызове.

`errorRead` / `errorWrite` получают `ctx.error` и не глотают ошибку: исходная
ошибка всё равно уходит вызывающему коду.

Хуки подключённых модулей выполняются перед хуком приложения с тем же именем;
первое явное решение останавливает цепочку.

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

Эти поля сохраняются в документе MongoDB, поэтому клиент не может подделать create/edit metadata. В журнал они не пишутся: кто и когда — это `userId` и `createdAt` самой записи журнала.

## Sync и audit log

Каждая успешная запись добавляет компактную строку в log:

```js
{
  _id,
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

Клиенты вызывают `sync({ from, sessionId })`. Сервер читает не более 12 часов журнала, исключает session отправителя, применяет права на чтение, фильтрует запрещённые поля и возвращает `{ to, changes, hasMore? }`. Клиент автоматически проходит все окна с `hasMore`.

Если `from` старше 20 дней, сервер возвращает `reset: true`; клиент очищает локальный cache и перечитывает текущее состояние вместо воспроизведения старого журнала.

## Полезные ссылки

- Полная документация: [docs/ru](../../docs/ru/README.md)
- Настройка сервера: [docs/ru/server/setup.md](../../docs/ru/server/setup.md)
- Права доступа: [docs/ru/server/permissions.md](../../docs/ru/server/permissions.md)
- Sync protocol: [docs/ru/architecture/sync-protocol.md](../../docs/ru/architecture/sync-protocol.md)

## Внутренние файлы

- `index.js` — CRUD, sync, запись в лог, публичная фабрика.
- `access.js` — декларативные права групп, `accessAllows` и фильтрация полей.
- `hooks.js` — runner серверных read/write lifecycle hooks.
- `rpc.js` — диспатчер WebSocket RPC.
- `socket.js` — реестр WebSocket-клиентов и broadcast.
- `auth.js` — login/hash-аут и адаптер паролей.
