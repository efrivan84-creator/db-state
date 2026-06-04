# Code access rules

> [English](../../en/server/code-access-rules.md) · **Русский**

Code access rules нужны, когда `_permission` недостаточно: owner-based доступ, tenant checks, особые запреты на delete, внешние ACL.

## Rule lookup

```js
const dbState = createDbStateServer({
  mongo,
  tables: ["order"],
  access: {
    order: {
      read: async (ctx) => true,
      write: async (ctx) => false
    },
    read: async (ctx) => undefined,
    write: async (ctx) => undefined
  }
})
```

Порядок: `access[table][action]` -> `access[action]` -> `_permission` -> deny.

## Context object

Rule получает контекст:

```ts
{
  action: "read" | "insert" | "update" | "delete",
  table: string,
  id?: string,
  user,
  userId,
  obj?,
  old?,
  set?,
  unset?,
  change?,
  loadDoc: () => Promise<object | null>
}
```

`loadDoc()` ленивый: документ грузится только если rule его вызвал.

## Return values

| Return | Значение |
|---|---|
| `true` | Разрешить все поля. |
| `false` | Запретить. |
| `{ action: true, fields: [...] }` | Разрешить только поля. |
| `{ action: false }` | Запретить. |
| `undefined` / `null` | Нет решения, перейти к следующему слою. |

## Паттерны

### Owner-only access

```js
access: {
  order: {
    read: async ({ user, loadDoc }) => {
      const doc = await loadDoc()
      return doc?.ownerId === user._id
    },
    write: async ({ user, loadDoc }) => {
      const doc = await loadDoc()
      return doc?.ownerId === user._id
    }
  }
}
```

### Action-specific deny

```js
write: async ({ action, user }) => {
  if (action === "delete") return user.groups?.includes("admin")
  return undefined
}
```

### Field whitelist из кода

```js
write: async ({ user }) => {
  if (user.groups.includes("manager")) {
    return { action: true, fields: ["status", "comment"] }
  }
}
```

### Конкретные document ids

```js
read: ({ id }) => id === "public-config" ? true : undefined
```

### Dynamic group check

```js
read: async ({ user, loadDoc }) => {
  const doc = await loadDoc()
  return user.groups?.includes(`project:${doc.projectId}`)
}
```

### Смешивание с `_permission`

Возвращай `undefined`, если code rule не знает ответа. Тогда решение примет `_permission`.

## Sync optimization: lazy doc loading

Во время sync сервер может обработать много log rows. Если permission можно решить по table/user/groups, документ не загружается. Вызывай `loadDoc()` только когда без документа нельзя.

## Async rules

Rules могут быть async: можно обращаться к Redis, внешнему ACL service или другой коллекции. Но каждый async call увеличивает latency RPC/sync, поэтому кэшируй общие решения.

## Decision composition

Не пиши сложные правила как один огромный `if`. Разделяй common allow, explicit deny и fallback:

```js
write: async (ctx) => {
  if (ctx.user.groups.includes("admin")) return true
  if (ctx.action === "delete") return false
  return undefined
}
```

## Type safety

Типы доступны в `.d.ts`; для больших проектов объяви свои context helpers и table-specific predicates, чтобы не разносить строки групп по коду.

## Тестирование

Пиши тесты на:

- allow и deny;
- field filtering;
- `insert`, `update`, `delete` отдельно;
- sync behavior;
- отсутствие лишних `loadDoc()` в common path.

## Performance tip

Сначала short-circuit дешевые случаи:

```js
if (user.groups.includes("admin")) return true
if (!user) return false
const doc = await loadDoc()
```

Это особенно важно для sync batch.
