# Code access rules

When `_permission` rows aren't expressive enough — for example, "user can read their own orders" — write rules in JavaScript. They run **before** any `_permission` lookup and can decide, deny, or pass.

## Two scopes

```js
createDbStateServer({
  mongo,
  tables: ["order"],
  access: {
    table: {
      order: {
        read:  async (ctx) => { ... },
        write: async (ctx) => { ... }
      }
    },
    doc: {
      order: {
        "special-order-id": {
          read:  async (ctx) => true,
          write: async (ctx) => false
        }
      }
    }
  }
})
```

| Scope | When evaluated |
|---|---|
| `access.doc[table][id][action]` | First. If defined, checked first for that specific document. |
| `access.table[table][action]` | Second. If defined, checked for any document in that table. |
| `_permission` rows | Third. Only if both above return `null` / `undefined`. |
| Deny | If nothing decides. |

The first rule that returns a non-null value wins.

## The context object

Every rule receives a `ctx` argument:

```ts
interface AccessContext<T = BaseDoc> {
  req?: unknown        // the original RPC request envelope (whatever you forwarded via getUser)
  user?: AccessUser    // resolved authenticated user, or undefined for anonymous
  table: string
  id: string           // document id
  docId: string        // alias for id
  obj?: T              // current state of the doc (post-update for writes, current for reads)
  old?: T              // previous state (for update and delete)
  set?: Partial<T>     // requested set fields (for update)
  unset?: string[]     // requested unset paths (for update)
  change?: Change<T>   // the change being checked (in sync filtering)
  action?: "insert" | "update" | "delete"  // when invoked from a write or sync
  loadDoc?: () => Promise<T | undefined>   // lazy Mongo loader (sync only)
  permissionRules?: ServerPermissionRule[]  // pre-fetched rules for this table (sync only)
}
```

The `user` shape:

```ts
interface AccessUser {
  _id: string
  login?: string
  groups?: string[]
}
```

## Return values

A rule can return any of:

| Returned | Meaning |
|---|---|
| `true` | Allow. |
| `false` | Deny. |
| `{ allowed: true, fields: ["a", "b"] }` | Allow with field whitelist. |
| `{ action: false }` | Deny (legacy compat with `_permission` shape). |
| `{ action: true, fields: [...] }` | Allow with fields. |
| `null` or `undefined` | No decision — pass to the next layer. |

Use `null`/`undefined` deliberately when you only want to handle a subset of cases:

```js
read: ({ user, id }) => {
  if (id === "public") return true       // always allow this one
  if (!user) return false                // hard deny anonymous
  return undefined                        // let _permission rules decide
}
```

## Patterns

### Owner-only access

```js
access: {
  table: {
    order: {
      read: async (ctx) => {
        if (!ctx.user) return false
        const obj = ctx.obj ?? await ctx.loadDoc?.()
        return obj?.ownerId === ctx.user._id
      },
      write: async (ctx) => {
        if (!ctx.user) return false
        // For inserts, obj is the new doc.
        // For updates/deletes, obj is the current/old state.
        return ctx.obj?.ownerId === ctx.user._id || ctx.old?.ownerId === ctx.user._id
      }
    }
  }
}
```

### Action-specific deny

```js
access: {
  table: {
    order: {
      write: async (ctx) => {
        if (ctx.action === "delete") {
          return ctx.user?.groups?.includes("admin")  // only admins delete
        }
        return undefined  // for insert/update, fall through to _permission
      }
    }
  }
}
```

### Field whitelist from code

```js
access: {
  table: {
    order: {
      read: async (ctx) => {
        if (!ctx.user) return false
        if (ctx.user.groups?.includes("admin")) return true
        if (ctx.user.groups?.includes("manager")) {
          return { allowed: true, fields: ["_id", "status", "total"] }
        }
        return false
      }
    }
  }
}
```

The `fields` here is applied exactly like `_permission.read.fields` — server projects reads, validates writes.

### Per-document rules

For one specific document with special handling:

```js
access: {
  doc: {
    order: {
      "o_global_announcement": {
        read: async () => true,            // everyone can read
        write: async ({ user }) => user?._id === "u_admin"  // only one user writes
      }
    }
  }
}
```

Useful for singleton documents (app settings, announcements, feature flags).

### Dynamic group check

```js
access: {
  table: {
    project: {
      read: async (ctx) => {
        if (!ctx.user) return false
        const obj = ctx.obj ?? await ctx.loadDoc?.()
        if (!obj) return false
        // The project document has a "memberIds" field.
        return obj.memberIds?.includes(ctx.user._id)
      }
    }
  }
}
```

### Mixing code rules with `_permission`

A common pattern: handle the dynamic check in code, but leave field-level projection to `_permission`. Return `undefined` from code → falls through.

```js
// Code rule: deny if not a member.
access: {
  table: {
    project: {
      read: async (ctx) => {
        const obj = ctx.obj ?? await ctx.loadDoc?.()
        if (!obj?.memberIds?.includes(ctx.user._id)) return false
        return undefined  // pass to _permission for field rules
      }
    }
  }
}

// _permission: handle field projection per role.
{
  table: "project",
  read: { groups: ["viewer"], fields: ["_id", "name", "memberIds"] }
}
{
  table: "project",
  read: { groups: ["editor"], fields: ["_id", "name", "memberIds", "tasks"] }
}
```

The code rule decides membership; `_permission` decides which fields each role sees within member projects.

## Sync optimisation: lazy doc loading

During `sync()`, the server filters every change through `read` access. Loading the full document for each change would be O(N) Mongo queries.

Two optimisations are in place:

1. `_permission` rows are fetched once per table per sync call (`permissionRulesByTable` cache).
2. The document is loaded **only if a rule asks for it** via `ctx.loadDoc()`.

Your code rules should follow the same pattern:

```js
read: async (ctx) => {
  // Cheap check first — no doc needed.
  if (ctx.user?.groups?.includes("admin")) return true

  // Only load the doc if we couldn't decide cheaply.
  const obj = ctx.obj ?? await ctx.loadDoc?.()
  return obj?.ownerId === ctx.user._id
}
```

If you call `loadDoc()` unconditionally in a hot table, sync slows down.

For `_permission` rows: if none of them have `if`, the library skips loading the doc entirely during sync. A rule like `if: { status: "open" }` on a busy table is more expensive: non-delete changes that reach permission filtering may need a document read so the condition can be evaluated. Delete changes use the `old` snapshot already stored in the log.

## Async rules

All callbacks may be async — return a Promise. The library awaits each. Use this to:

- Check membership in a Redis set: `await redis.sismember(...)`.
- Call an external auth service (rare; better to inject the result via `getUser`).
- Apply a per-tenant policy from a separate config collection.

Be aware: every RPC call awaits every rule that applies. Slow rules slow down every request.

## Decision composition (the gotcha)

Code rules at the **doc** scope are checked first. If they return a non-null value, the **table** code rule and `_permission` rows are **skipped**.

So:

```js
access: {
  doc: { order: { "o1": { read: async () => false } } },
  table: { order: { read: async () => true } }
}
```

For `o1`: returns `false` from doc rule → denied. The table rule is not consulted. If you want table rules to apply unless doc rules say otherwise, return `null` from the doc rule when you don't want to decide.

## Type safety

Type your rules per table:

```ts
import type { AccessRule, AccessContext } from "@db-state/server-mongo"

type Order = { _id: string; status: string; ownerId: string; total: number }

const ownerOnly: AccessRule<Order> = async (ctx) => {
  return ctx.obj?.ownerId === ctx.user?._id
}

createDbStateServer({
  mongo,
  tables: ["order"],
  access: {
    table: { order: { read: ownerOnly, write: ownerOnly } }
  }
})
```

`AccessConfig` accepts `AccessRule<any>` in its slots, so subtypes work.

## Testing

Code rules are plain functions — test them in isolation:

```js
import { assert } from "node:test/reporters"
import test from "node:test"

const rule = async (ctx) => ctx.obj?.ownerId === ctx.user?._id

test("only owner reads", async () => {
  assert.equal(await rule({ user: { _id: "u1" }, obj: { ownerId: "u1" } }), true)
  assert.equal(await rule({ user: { _id: "u1" }, obj: { ownerId: "u2" } }), false)
  assert.equal(await rule({ user: undefined, obj: { ownerId: "u1" } }), false)
})
```

For end-to-end tests, the library's own [test/server-mongo.test.js](../../../test/server-mongo.test.js) is a working example of seeding a memory Mongo and exercising the access layer.

## Performance tip: short-circuit common cases

If 90% of requests are "admin doing anything", put that check at the very top:

```js
read: async (ctx) => {
  if (ctx.user?.groups?.includes("admin")) return true   // single property check, no awaits
  // ... heavier checks below
}
```

Admin requests resolve in a sync microsecond. Only non-admin paths hit the expensive checks.
