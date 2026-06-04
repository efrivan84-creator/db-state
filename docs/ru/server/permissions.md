# Права доступа

> [English](../../en/server/permissions.md) · **Русский**

Главное правило: доступ запрещен по умолчанию. Каждый RPC должен пройти read/write decision на сервере.

## Deny-by-default

Если нет code access rule и нет подходящей строки `_permission`, сервер вернет `Read denied` или `Write denied`.

Это касается и служебных таблиц `_user`, `_group`, `_permission`.

## Таблица `_permission`

```js
{
  _id: "perm_order_manager",
  table: "order",
  priority: 10,
  if: { status: "open" },

  read: {
    groups: ["manager"],
    fields: ["_id", "status", "total"],
    action: true
  },

  write: {
    groups: ["admin"],
    fields: ["status", "comment"],
    action: true
  }
}
```

Поля:

| Поле | Значение |
|---|---|
| `table` | Таблица, к которой относится правило. |
| `priority` | Чем выше, тем раньше проверяется. |
| `if` | Условие на документ. Сейчас equality-style matching. |
| `read` | Правило чтения. |
| `write` | Правило записи. |
| `users` | Разрешенные user ids. |
| `groups` | Разрешенные группы. |
| `fields` | Разрешенные поля. |
| `action` | `true` allow, `false` explicit deny. |

Если `fields` не указаны, разрешены все поля. Если `action` не указан, совпавший user/group считается allow.

## Порядок проверки

1. Table-specific code access rule: `access[table].read/write`.
2. Global code access rule: `access.read/write`.
3. `_permission` rows по `table`, сортировка `priority: -1`.
4. Deny.

Code rules могут вернуть `undefined`, чтобы передать решение дальше.

## Примеры

### Открыть таблицу группе

```js
{
  table: "order",
  priority: 10,
  read: { groups: ["admin"], action: true },
  write: { groups: ["admin"], action: true }
}
```

### Менеджеры видят часть полей

```js
{
  table: "order",
  priority: 10,
  read: {
    groups: ["manager"],
    fields: ["_id", "status", "total", "createdAt"],
    action: true
  },
  write: {
    groups: ["manager"],
    fields: ["status", "comment"],
    action: true
  }
}
```

### Доступ по состоянию документа

```js
{
  table: "order",
  priority: 20,
  if: { status: "open" },
  read: { groups: ["manager"], action: true }
}
```

### Layered allow/deny

```js
{ table: "order", priority: 100, if: { locked: true }, write: { groups: ["manager"], action: false } }
{ table: "order", priority: 10, write: { groups: ["manager"], action: true } }
```

Более высокий priority может явно запретить то, что низкий разрешил бы.

## Field projection на чтении

`read.fields` применяется к:

- `load()`;
- `getUnique()`;
- `sync()` changes (`obj`, `set`, `unset`, `old`).

Если поле скрыто, клиент его не получает, даже если документ в MongoDB его содержит.

## Field validation на записи

`write.fields` проверяет:

- insert object в `add()`;
- `set` paths в `update()`;
- `unset` paths в `update()`.

Запрещенное поле отклоняет всю операцию.

## Service tables

Для админки можно открыть служебные таблицы так же, как обычные:

```js
{
  table: "_permission",
  read: { groups: ["admin"], action: true },
  write: { groups: ["admin"], action: true }
}
```

Будь осторожен: пользователь с write доступом к `_permission` может расширить свои права.

## Как sync учитывает permissions

Sync фильтрует log rows по read access текущего пользователя. Для update field-level rules могут оставить только разрешенные paths. Для delete проверка может использовать `change.old`.

## Частые ошибки

### Admin получает `Write denied`

Проверь, что есть правило для нужной таблицы и группа пользователя реально содержит `"admin"`. Service tables не открываются автоматически.

### Field-level write отклоняет update

В `write.fields` нужно включить все paths, которые клиент отправляет. Серверные `info.*` поля добавляются отдельно и не должны приходить с клиента.

### Sync не возвращает changes

Проверь read permission на таблицу и `if` условия. Если право зависит от документа, убедись, что rule применимо к старому/новому состоянию.

## Live editing permissions

Permissions сами являются db-state таблицей. Можно сделать админский UI поверх `_permission`, но изменения прав влияют на дальнейшие RPC только после записи и следующей проверки.
