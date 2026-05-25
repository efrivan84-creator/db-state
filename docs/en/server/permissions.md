# Permissions

This is the most important page in the documentation. Read it once carefully — every other security decision in your app flows from this model.

## The deny-by-default rule

The server denies every read and every write unless **something explicitly allows it**. There is no implicit access. A user with no matching rule sees nothing and writes nothing.

When a request arrives, the server runs `assertAccess` in this order:

```
1. Code rule for (table, docId, action) — see code-access-rules.md
2. Code rule for (table, action) — also code-access-rules.md
3. _permission row matching table + if-conditions — this page
4. Deny.
```

The first rule that returns a non-`null` decision wins. If none match, access is denied.

## The `_permission` table

Each row is a Mongo document like this:

```js
{
  _id: "perm_order_open",
  table: "order",
  priority: 10,

  if: {
    status: "open"
  },

  read: {
    users:   ["u_123"],
    groups:  ["manager", "viewer"],
    action:  true,                              // optional, defaults to true if user/group matches
    fields:  ["_id", "status", "total"]         // optional, whitelist of paths
  },

  write: {
    users:   [],
    groups:  ["manager"],
    action:  true,
    fields:  ["status", "comment"]
  }
}
```

Field by field:

| Field | Required | Meaning |
|---|---|---|
| `_id` | yes | Any unique string. |
| `table` | yes | App table name this rule applies to. |
| `priority` | no (default 0) | Higher number = checked first. |
| `if` | no | Equality-only matcher on the document. If absent, applies to all docs. |
| `read` | no | `PermissionPart` for read access. |
| `write` | no | `PermissionPart` for write access (insert + update + delete). |

A `PermissionPart`:

| Field | Required | Meaning |
|---|---|---|
| `users` | no | List of user `_id`s allowed by this part. |
| `groups` | no | List of group names allowed (matched against `user.groups[]`). |
| `action` | no | If `false`, explicitly denies even when user/group matches. Defaults to `true`. |
| `fields` | no | Whitelist of dot-paths the user may read/write. If absent, all fields allowed. |

The user matches when **either** `users.includes(user._id)` **or** `user.groups` has overlap with `groups`. After matching, `action: false` overrides to deny; otherwise allow.

## Evaluation order

For each `(table, action)` request, the server:

1. Fetches all `_permission` rows where `table === request.table`, sorted by `priority` descending.
2. For each row, checks `if` against the document (`ctx.obj` for writes/reads of existing docs; `ctx.old` for deletes).
3. For the first row whose `if` matches:
   - Evaluates `part = row[action]`.
   - If `part` is undefined → continue to next row.
   - If `part` is defined and the user matches → return `{ allowed: action !== false, fields: part.fields }`.
   - If the user does **not** match → continue to next row.
4. If no row decided, return deny.

**Key subtlety**: only the **first matching row with a decision** wins. Lower-priority rules don't accumulate. If you want layered permissions, use `priority` to order them and design each rule to either decide or pass.

## Examples

### 1. Open everything to one group

```js
{
  _id: "perm_admin",
  table: "order",
  priority: 100,
  read:  { groups: ["admin"] },
  write: { groups: ["admin"] }
}
```

Admins can read every order and write to every order. No field restrictions.

### 2. Managers see only some fields and can only edit status

```js
{
  _id: "perm_manager",
  table: "order",
  priority: 10,
  read:  { groups: ["manager"], fields: ["_id", "status", "total", "comment"] },
  write: { groups: ["manager"], fields: ["status", "comment"] }
}
```

A manager doing `state.order.load("o1")` gets a projection containing only the four whitelisted fields plus `_id`/`id`. A manager doing `state.order.update({ id: "o1", set: { margin: 999 } })` gets `"Write denied: field margin"`.

### 3. State-conditional access

```js
{
  _id: "perm_closed_readonly",
  table: "order",
  priority: 20,
  if: { status: "closed" },
  read:  { groups: ["manager"] },
  write: { groups: ["manager"], action: false }
}

{
  _id: "perm_open_writable",
  table: "order",
  priority: 10,
  read:  { groups: ["manager"] },
  write: { groups: ["manager"], fields: ["status", "comment"] }
}
```

Closed orders are read-only for managers (any write returns "Write denied"). Open orders allow editing status/comment.

The `if` matches by equality only — `{ status: "closed" }` matches docs where `status === "closed"`. For richer conditions (`$in`, `$ne`, dot-paths into the user), use [code access rules](code-access-rules.md).

### 4. Layered allow/deny with priority

```js
// Catch-all: managers can read everything
{
  _id: "perm_manager_read_all",
  table: "order",
  priority: 1,
  read: { groups: ["manager"] }
}

// But: deny reading "secret" orders specifically
{
  _id: "perm_secret_deny",
  table: "order",
  priority: 100,
  if: { type: "secret" },
  read: { groups: ["manager"], action: false }
}
```

For a doc with `type: "secret"`: the priority-100 rule matches `if`, has a `read` part, the user is in `groups: ["manager"]` — decision = `action: false` → deny. For other docs: priority-100 doesn't match `if`, fall through to priority-1, allow.

### 5. Field-level writes with two rules

```js
{
  _id: "perm_manager_status",
  table: "order",
  priority: 10,
  write: { groups: ["manager"], fields: ["status"] }
}
```

A manager can change `status`. They can't change `total`, `margin`, anything else.

For inserts (`add`), every dot-path in the new object's fields must be in `write.fields`. So a manager can't `add` an order with `margin: 100` either.

For deletes (`remove`), the `write` part is checked at the **document** level — `fields` is ignored. If you want stricter delete rules, use [code rules](code-access-rules.md).

## Field projection on reads

If a matched `read.fields` is present:

- **`load(id)`** returns only the listed fields plus `_id` and `id`.
- **`getIds(query)`** still works (the filter runs on full Mongo docs), but only ids of visible docs are returned.
- **`getUnique({field})`** filters by readability per row, then projects, then extracts the field. If `field` is not in `read.fields`, you get nothing.
- **`sync` changes** are projected too: `insert.obj` is projected, `delete.old` is projected, `update.set`/`update.unset` are filtered to only keep allowed paths. If everything in a change is filtered out, the change is dropped from the sync result entirely.

This means clients literally cannot see forbidden fields — not in the cache, not in the sync log, not via getUnique. The projection is server-side.

## Field validation on writes

When a write happens, the server collects every dot-path the change touches:

```js
update({ set: { status: "closed", "profile.city": "Moscow" }, unset: ["draft"] })
// touches: ["status", "profile.city", "draft"]
```

If `write.fields` is set on the matching rule, every touched path must be **at or under** an allowed field:

```js
fields: ["status", "profile"]
// allowed: "status", "profile", "profile.city", "profile.x.y.z"
// forbidden: "total", "margin", "draft"
```

The check is a `startsWith` on dot-paths — `"profile"` allows the whole subtree. Use granular paths if you want to allow only `profile.city` but not `profile.name`.

If any path fails, the **whole operation is rejected** — partial updates don't happen.

## Permissions for service tables

`_user`, `_group`, `_permission` are normal tables — they follow the same rules. You'll usually have:

```js
{ _id: "perm_user_admin",       table: "_user",       priority: 100, read: { groups: ["admin"] }, write: { groups: ["admin"] } },
{ _id: "perm_group_admin",      table: "_group",      priority: 100, read: { groups: ["admin"] }, write: { groups: ["admin"] } },
{ _id: "perm_permission_admin", table: "_permission", priority: 100, read: { groups: ["admin"] }, write: { groups: ["admin"] } }
```

**Without these, even admins can't manage users/groups/permissions through the library** — deny by default applies here too. The demo2 app seeds exactly these three rules.

If you want users to see their own `_user` record but not others:

```js
// This needs a code rule, since "id matches the caller's id" is not expressible in if:
access: {
  _user: {
    read: ({ user, id }) => id === user?._id ? true : null  // null = pass to next layer
  }
}
```

See [code-access-rules.md](code-access-rules.md).

## How sync respects permissions

When a client calls `sync(from)`, the server:

1. Reads all log entries with `createdAt > from`.
2. For each entry, evaluates `read` access **as the caller**, using:
   - `ctx.obj` = current document (loaded lazily, only if needed)
   - `ctx.old` = `change.old` for deletes
   - `ctx.change` = the change itself
3. If allowed, filters the change's fields by `read.fields`.
4. If the entire change has no surviving fields, drops it.

This means a client never sees changes they couldn't have seen anyway. **The log is filtered per client.**

For performance: if a permission rule has no `if`, the server can decide access without loading the document. With `if`, it must `findOne` to check. That's why even minor `if` conditions on hot tables can multiply sync cost.

## Common pitfalls

### "Why does my admin get Write denied?"

Most likely: there's a higher-priority rule with `action: false` matching. List rows for that table sorted by priority and trace which one matches.

### "Field-level write rejects my update"

Check `write.fields` of the matching rule. Every key in `set` and entry in `unset` must be at or under an allowed prefix.

Common surprise: `set: { "_id": "..." }` — `_id` is treated as a normal path. It's filtered out before write checks (the library knows `_id` is immutable), but if you somehow pass it through it could trip you up.

### "Sync returns no changes even though there are updates"

Either:
1. The session id matches and the server is suppressing echo.
2. The read permission denies access to those changes.
3. The `time1` cursor is already at or beyond the latest change.

### "A user can read but everyone else gets a 'Write denied' error on the same field"

Field whitelists on `read` and `write` are independent. Common pattern: managers can `read` `margin` (it's in `read.fields`) but can't `write` it (it's not in `write.fields`).

### "Adding a row throws 'Write denied: field X'"

For inserts, every field in the new object is validated against `write.fields`. If you want managers to insert with the default `status: "open"` and let admins set everything, structure the insert to include only manager-allowed fields.

## Editing permissions live

Because `_permission` is a normal table, you can build an admin UI to edit rules at runtime. The library re-reads `_permission` on every check (with a small per-sync cache), so changes take effect immediately for new requests.

The demo2 app has a JSON-textarea editor for `_permission` — see [cookbook/admin-panel.md](../cookbook/admin-panel.md#server-permissions).

Be careful giving non-admin groups write access to `_permission` itself — they could grant themselves new rules.
