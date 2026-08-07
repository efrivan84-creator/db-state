# Что клиент может запросить у сервера

Полный список того, что поддерживается библиотекой на сегодня. Всё идёт по одному WebSocket-соединению.

Запросов ровно три вида:

1. **Системные сообщения** — вход, восстановление сессии, выход.
2. **RPC** — восемь встроенных методов плюс ваши собственные.
3. **Файлы** — отдельный протокол `dbfile:*`, если подключён `@db-state/server-files`.

Плюс сервер сам присылает клиенту сигналы, без запроса.

---

## 1. Системные сообщения

Отправляются как `{ type, id, ... }`. RPC до авторизации отклоняется с `Unauthorized`.

| Сообщение | Что делает | Клиент | Ответ сервера |
| --- | --- | --- | --- |
| `dbstate:login` | Вход по логину и паролю. Возвращает `hash` для последующих переподключений | `state.login(login, password)` | `dbstate:login_result` c `userId`, `hash`, `groups`, `access`; или `dbstate:login_error` |
| `dbstate:auth` | Восстановление сессии по `userId` + `hash`, без пароля. Используется при переподключении | автоматически при reconnect | `dbstate:auth_result` c теми же полями; или `dbstate:auth_error` |
| `dbstate:logout` | Сбрасывает пользователя на сокете | `state.logout()` | `dbstate:logout_result` |

В `login_result` / `auth_result` приходит слитый объект прав `access` — клиент может прятать разделы интерфейса, не спрашивая сервер. Подробнее: [права доступа](server/permissions.md).

---

## 2. RPC-методы

Отправляются как `{ type: "dbstate:rpc", id, method, payload }`, ответ — `dbstate:rpc_result` или `dbstate:rpc_error`.

### Чтение

| Метод | Payload | Возвращает | Право | Клиентский вызов |
| --- | --- | --- | --- | --- |
| `getIds` | `table`, `filter`, `sort`, `skip`, `limit` | Массив id | `read` | `table.getIds(query)`, `table.idsRef(query)`, `table.listRef(query)` |
| `load` | `table`, `id` | Один документ | `read` | `table.load(id, key)`, `table.getAsync(id, key)` |
| `count` | `table`, `filter` | Число | `read` | `table.countRef(filter)` |
| `getUnique` | `table`, `field`, `filter` | Массив уникальных значений поля | `read` | `table.getUnique(query)` |
| `sync` | `from`, `sessionId` | `{ to, changes, hasMore? }` или `{ to, changes: [], reset: true }` | `read` на каждую таблицу | `state.syncNow()`, обычно автоматически |

### Запись

| Метод | Payload | Возвращает | Право | Клиентский вызов |
| --- | --- | --- | --- | --- |
| `add` | `table`, `obj`, `sessionId` | `{ ok, id, change }` | `write` | `table.add(obj, key)` |
| `update` | `table`, `id`, `set`, `unset`, `sessionId` | `{ ok, change }` | `write` | `table.update({ id, set, unset }, key)` |
| `remove` | `table`, `id`, `sessionId` | `{ ok, change }` | `write` | `table.remove(id, key)` |

Записи нельзя выполнить офлайн — они требуют живого сокета. Чтение работает из кэша.

### Что происходит с правами

- `read` управляет `load`, `getIds`, `getUnique`, `count` и видимостью изменений в `sync`.
- `write` управляет `add`, `update`, `remove`.
- Фильтр права уходит **в сам запрос к базе**, поэтому недоступные строки просто не возвращаются. Сколько их скрыто — клиенту не сообщается.
- `read_fields` / `write_fields` ограничивают набор полей. При чтении лишние поля не приходят, при записи запрос с чужим полем **отклоняется целиком** с ошибкой `Write denied: field <путь>`.
- `read_fields` ограничивает и `filter`: условие по скрытому полю отклоняется с `Read denied: field <путь>` — иначе значение подбиралось бы перебором по наличию строк в ответе. По разрешённым полям фильтр не ограничен ничем, в том числе `$regex`.
- Обращение к таблице, не указанной в `tables`, отклоняется с `Unknown db-state table`.

Поля `info.makeid`, `info.makedata`, `info.editid`, `info.editdata` сервер проставляет сам — клиентские значения в них вырезаются.

### Свои методы

Кроме встроенных восьми, сервер может отдавать любые собственные RPC:

```js
createDbStateServer({
  methods: { "zad.get-num": async ({ body, user, db }) => { ... } },
  methodsDir: import.meta.dirname + "/rpc"   // "zad.get-num" → rpc/zad/get-num.js
})
```

Вызов с клиента — `state.socket.rpc("zad.get-num", payload)`. Файлы из `methodsDir` перечитываются при изменении, перезапуск не нужен. Встроенные проверки прав и запись в журнал изменений на свои методы **не распространяются** — за это отвечает сам обработчик. Подробнее: [API сервера](server/api-reference.md).

---

## 3. Файлы

Доступны при подключённом `@db-state/server-files`. Идут по тому же сокету отдельным протоколом.

| Сообщение | Что делает |
| --- | --- |
| `dbfile:upload_start` | Начать загрузку; дальше клиент шлёт бинарные фреймы, сервер отвечает `dbfile:upload_next` |
| `dbfile:download_start` | Начать скачивание; сервер отвечает `dbfile:download_info` и бинарными фреймами |
| `dbfile:download_next` | Запросить следующую порцию |

Ответы: `dbfile:upload_done`, `dbfile:download_done`, `dbfile:error`. Прямая запись в таблицу файлов через `add`/`update`/`remove` запрещена, доступ к бинарным данным управляется `token + downloadPolicy`. Одновременно на сокет — одна загрузка и одно скачивание. Подробнее: [файлы](files.md).

---

## 4. Что сервер присылает сам

Это не запросы клиента — сервер инициирует их сам.

| Сообщение | Смысл |
| --- | --- |
| `dbstate:changes_available` | В базе что-то изменилось, пора вызвать `sync`. Рассылка задерживается и ограничивается по частоте |
| `dbstate:force_resync` | Клиенту нужно синхронизироваться принудительно |
| `dbstate:error` | Ошибка уровня соединения |

Клиент по умолчанию **не опрашивает** сервер по таймеру: `sync` запускается после авторизации и по сигналу.

---

## Границы

Чего в библиотеке сейчас нет:

- транзакций и атомарной записи в несколько таблиц — только по одному документу за раз;
- очереди офлайн-записей — запись требует соединения;
- докачки файла после обрыва — прерванная загрузка помечается `failed`;
- подписки на конкретный фильтр — сигнал `changes_available` общий, клиент сам решает, что перечитать.

Один ответ `sync` покрывает не более 12 часов журнала; если клиент отстал сильнее, он проходит окна подряд по `hasMore`. Курсор старше 20 дней получает `reset: true` — клиент очищает кэш и перечитывает актуальное состояние.

## Дальше

- [Реактивные запросы](client/reactive-queries.md) — `listRef`, `idsRef`, `countRef`
- [Изменения данных](client/mutations.md) — `add`, `update`, `remove`
- [Права доступа](server/permissions.md) — группы, фильтры, поля
- [API сервера](server/api-reference.md) — все опции `createDbStateServer`
- [Протокол синхронизации](architecture/sync-protocol.md) — формат кадров
