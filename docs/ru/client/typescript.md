# TypeScript

> [English](../../en/client/typescript.md) · **Русский**

Пакеты поставляются с `.d.ts`. Главная точка типизации - schema generic в `createDbState`.

## Schema generic

```ts
import { createDbState } from "@db-state/vue"

type Schema = {
  user: { _id: string; name: string; email: string }
  order: { _id: string; status: "open" | "closed"; total: number }
}

export const state = createDbState<Schema>({
  tables: ["user", "order"],
  wsUrl: "ws://127.0.0.1:8788/db-state/ws"
})
```

После этого `state.user`, `state.order`, filters, sort и update payloads получают типы.

## Что типизируется

### `load`

```ts
const order = state.order.load("o1")
order.status // "open" | "closed"
order.total  // number
```

### `update`

```ts
await state.order.update({
  id: "o1",
  set: { status: "closed" }
})
```

Ключи `set` остаются string/dot-path friendly, потому что Mongo-style nested update не всегда выразим строго.

### Filters

```ts
state.order.listRef({
  filter: { status: "open" }
})
```

### Sort

```ts
state.order.idsRef({
  sort: { total: -1 }
})
```

### `listRef` и `countRef`

```ts
const orders = state.order.listRef({ limit: 50 })
const count = state.order.countRef({ status: "open" })
```

## Service tables

`_user`, `_group` не добавляются автоматически. Укажи и типизируй их явно, если UI работает с админскими таблицами:

```ts
type Schema = {
  order: Order
  _user: {
    _id: string
    login: string
    groups: string[]
    disabled?: boolean
  }
}
```

## Change shape

```ts
import type { Change } from "@db-state/core"

function onOrderChange(change: Change<Order>) {
  if (change.action === "update") {
    console.log(change.set)
  }
}
```

`state.onChange` и table hooks получают `Change`.

## Discriminated unions

Можно моделировать доменные варианты:

```ts
type Payment =
  | { _id: string; kind: "card"; last4: string }
  | { _id: string; kind: "bank"; iban: string }

const payment = state.payment.load("p1")

if (payment.kind === "card") {
  payment.last4
}
```

## Custom socket events

Создай свои типы payloads рядом с кодом:

```ts
type AppEvents = {
  "chat:typing": { roomId: string; userId: string }
}

function sendEvent<T extends keyof AppEvents>(type: T, payload: AppEvents[T]) {
  state.socket.send(type, payload)
}
```

## Generic helpers

`@db-state/core` экспортирует общие типы вроде `Filter<T>`, `Sort<T>`, `Change<T>`. Используй их в helper-функциях:

```ts
import type { Filter } from "@db-state/core"

function activeOnly<T extends { archived?: boolean }>(filter: Filter<T> = {}) {
  return { ...filter, archived: false }
}
```

## TypeScript config

Рекомендуется стандартный ESM/Vite setup:

```json
{
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "target": "ES2022",
    "strict": true
  }
}
```

## Проверенные примеры

Типы используются в package `.d.ts`, README examples и тестах. Если runtime API меняется, обновляй TypeScript declarations в том же PR.
