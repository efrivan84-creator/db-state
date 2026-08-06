# Хуки сервера

Хуки — это точки, где приложение вмешивается в стандартные CRUD/sync-команды: правит запрос, ограничивает поля, разрешает или запрещает операцию, дополняет ответ.

Права как таковые живут не здесь, а в объекте `access` групп пользователя — см. [права доступа](permissions.md). Хук нужен там, где решение зависит от данных, которых в фильтре не выразить.

Полная картина порядка вызовов: [карта прохода запроса](../request-flow.md).

## Объявление

Хуков шесть, каждый объявляется один раз на весь сервер. Таблица разбирается внутри по `ctx.table`:

```js
createDbStateServer({
  mongo,
  tables: ["order", "bill"],
  hooks: {
    beforeRead: (ctx) => { ... },
    afterRead: (ctx) => { ... },
    errorRead: (ctx) => { ... },
    beforeWrite: (ctx) => { ... },
    afterWrite: (ctx) => { ... },
    errorWrite: (ctx) => { ... }
  }
})
```

Чтение — `getIds`, `load`, `count`, `getUnique`, `sync`. Запись — `add`, `update`, `remove`. Конкретная команда всегда в `ctx.method`.

## Что возвращать

| Возврат | Что происходит |
| --- | --- |
| `undefined` (ничего) | Решения нет — дальше проверяются права группы |
| `true` | Разрешено, права группы не проверяются |
| `false` | Запрет, общее сообщение `Read denied: <таблица>` |
| `{ allowed: false, reason: "..." }` | Запрет, причина уходит клиенту |

Изменения `ctx` применяются **всегда**, независимо от возврата. Обычный случай — поправить запрос и оставить решение правам группы:

```js
beforeRead: (ctx) => {
  if (ctx.table !== "zad" || ctx.method !== "getIds") return
  ctx.filter = { $and: [ctx.filter ?? {}, { ownerId: ctx.user._id }] }
  // возврата нет → решают права группы, но уже по суженному запросу
}
```

`afterWrite` запретить не может: он вызывается после записи в базу, дозаписи журнала и рассылки сигнала. Запрет ставится в `beforeWrite`.

## Правка запроса

В `beforeRead` доступны поля запроса — всё, что в них записано, уходит в базу:

```js
beforeRead: (ctx) => {
  ctx.filter = sanitizeFilter(ctx.filter)         // getIds, count, getUnique
  if (ctx.method === "getIds") ctx.limit = Math.min(ctx.limit || 200, 200)
}
```

`ctx.fields` ограничивает набор возвращаемых полей — попадает в projection запроса:

```js
beforeRead: (ctx) => {
  if (ctx.table === "bill" && !ctx.user.groups.includes("boss")) {
    ctx.fields = ["fio", "balans"]
  }
}
```

Хук может только **сузить** поля: расширить то, что разрешено `read_fields` группы, он не может.

В `beforeWrite` правятся `ctx.set` / `ctx.unset` (для `update`) и `ctx.obj` (для `add`):

```js
beforeWrite: (ctx) => {
  if (ctx.method !== "update") return
  ctx.set.status = String(ctx.set.status).toLowerCase()
}
```

## Правка ответа

```js
afterRead: (ctx) => {
  if (ctx.method !== "load" || ctx.table !== "bill") return
  ctx.result = { ...ctx.result, canEdit: ctx.user.groups.includes("boss") }
}
```

## Состав `ctx`

Общее: `method`, `table`, `user`, `req` (в `req.body` — payload клиента), `sessionId`.

Чтение: `filter`, `sort`, `skip`, `limit`, `field`, `fields`, `id`, `obj`, `rows`, `result`.

Запись: `id`, `obj`, `old`, `set`, `unset`, `action`, `actorId`, `now`, `change`, `result`.

В `errorRead` / `errorWrite` добавляется `ctx.error`. Исключение внутри самого error-хука подавляется — главной остаётся исходная ошибка.

## Примеры

### Запрет с понятной причиной

```js
beforeWrite: (ctx) => {
  if (ctx.method === "remove" && ctx.table === "bill") {
    return { allowed: false, reason: "Договоры не удаляются, используйте архив" }
  }
}
```

### Системные операции без прав

```js
beforeWrite: (ctx) => {
  if (ctx.req?.__internal) return true
}
```

### Аудит

```js
afterWrite: (ctx) => {
  audit.push({ who: ctx.actorId, what: ctx.method, table: ctx.table, id: ctx.id })
}
```

### Логирование отказов

```js
errorRead: (ctx) => {
  console.warn(`${ctx.method} ${ctx.table}: ${ctx.error.message}`)
}
```

## Хуки модулей

Подключённые модули (например `@db-state/server-files`) объявляют свои хуки. Они выполняются **перед** хуком приложения с тем же именем; первое явное решение (`true` или `false`) останавливает цепочку. Затирания не происходит: свой `beforeRead` можно писать спокойно.

## Что где решать

| Задача | Где |
| --- | --- |
| «свои документы», «своя группа», «только активные» | Фильтр в правах группы (`$adminid`, `$groupid`) |
| Постоянный список видимых полей для роли | `read_fields` в правах группы |
| Условие зависит от времени, параметров запроса, другой таблицы | `beforeRead` / `beforeWrite` |
| Ограничение и очистка клиентского фильтра | `beforeRead` |
| Жёсткий запрет с текстом | `beforeRead` / `beforeWrite` |
| Обогатить ответ | `afterRead` |
| Аудит и метрики | `afterWrite` |

Всё, что выражается фильтром, лучше держать в правах группы: они уходят прямо в запрос к базе, редактируются администратором и не требуют перезапуска сервера.

## Смотри также

- [Карта прохода запроса](../request-flow.md)
- [Права доступа](permissions.md)
- [API сервера](api-reference.md)
