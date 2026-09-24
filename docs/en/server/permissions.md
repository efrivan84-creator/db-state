# Permissions

This is the most important page in the documentation. Read it once carefully — every other security decision in your app flows from this model.

## The deny-by-default rule

The server denies every read and every write unless **something explicitly allows it**. There is no implicit access. A user with no matching grant sees nothing and writes nothing.

When a request arrives, the server checks access in this order:

```
1. beforeRead / beforeWrite hook — may allow, deny, or stay silent
2. user.access                   — merged from the user's groups at login (this page)
3. Deny.
```

The first step that returns an explicit decision wins. If none match, access is denied.

## The `access` object on groups

Permissions are **data on the group** (`_group`). Each group document carries an `access` object:

```js
{
  _id: "installers",
  name: "Installers",
  access: {
    zad:  { read: {}, write: { master: "$adminid" } },  // read all tickets, edit own
    bill: {
      read: { needact: true },                          // only matching documents
      read_fields: ["fio", "balans"]                    // and only these fields
    }
  }
}

{ _id: "boss", name: "Management", access: { fullaccess: 1 } }
```

The shape per table:

| Key | Meaning |
|---|---|
| `read` | Row filter for reads. `{}` — all rows. Absent — no read access. |
| `read_fields` | Field whitelist for reads. Absent — all fields. |
| `write` | Row filter for writes. `{}` — all rows. Absent — no write access. |
| `write_fields` | Field whitelist for writes. Absent — all fields. |

The only flag value is the special `fullaccess: 1` key — access to everything.

A `read` / `write` value must be a **filter object** (or an array of filters, which is what group merging produces). Any other value is not a grant and means full denial:

```js
{ zad: { read: {} } }              // access to every row
{ zad: { read: { city: "msk" } } } // access to matching rows
{ zad: { read: true } }            // DENIED — not a filter
{ zad: { read: 1 } }               // DENIED — not a filter
{ zad: { read: false } }           // DENIED
```

That way a typo or a stale record in the database never turns into unexpected access.

## Merging at login

At login the server merges the `access` of all the user's groups, then the user's personal `access` (a field on `_user`) on top. The merged object is attached as `user.access` and returned in `login_result` / `auth_result`, so the client can hide UI sections without extra requests.

Merging is **additive only** — there are no deny rules:

- filters for the same action from different groups combine into an **any-of** set (the document passes when at least one filter matches);
- `{}` (all rows) beats any filter;
- `*_fields` lists are united; a grant **without** a field limit removes the limit;
- **every** action is merged, not only `read` and `write`: permissions of named methods (`bill: { pay: {} }`, `olt: { manage: {} }`) merge by the same rules and are checked with `accessAllows`.

Changing a group's `access` applies on the user's next login or reconnect.

## Filters

A filter is a plain object of `dot.path -> expected value` pairs, all of which must match (Mongo semantics). `{}` matches every document.

Values support two placeholders:

- `"$adminid"` — the current user's id;
- `"$groupid"` — matches any of the current user's group ids (becomes `{ $in: groups }` in database queries).

```js
{ zad: { read: { master: "$adminid" } } }   // a technician sees only their tickets
{ zad: { read: { dep: "$groupid" } } }      // a department sees its own area
```

The `write` filter is checked against the **existing** document for `update` / `remove`, and against the **new** document for `add`.

## What `read` and `write` cover

| Action | RPC methods |
|---|---|
| `read` | `load`, `getIds`, `getUnique`, `count`, and change visibility in `sync` |
| `write` | `add`, `update`, `remove` |

`read_fields` projects `load` results and filters `sync` changes per field. `write_fields` validates the field paths of `add` / `update` — a patch touching a path outside the whitelist **rejects the whole operation** with `Write denied: field <path>` (nothing is silently dropped).

An empty list is still a whitelist, not an omitted limit: `read_fields: []` exposes only `_id`, which is always visible, and `write_fields: []` rejects every client field.

`read_fields` also closes a field to **filtering and sorting**: a query with a condition or `getIds.sort` entry on a hidden field is rejected with `Read denied: field <path>`. Otherwise the value could be guessed from whether rows match or from their order. Every ordinary filter path is checked, including ones nested in `$and` / `$or`, and field operators make no difference: `{ pass: "x" }` and `{ pass: { $regex: "^x" } }` are rejected alike. Opaque root operators whose field dependencies cannot be determined safely (`$expr`, `$where`, `$text`, `$jsonSchema`, and similar) are rejected while `read_fields` is active. `_id` is still allowed because it is always returned.

## The database evaluates filters

Access checks are pushed into Mongo instead of being applied per row in JS:

- `getIds` / `count` / `getUnique` merge the access condition straight into the query (`{ $and: [clientFilter, { $or: [accessFilters] }] }`); the database returns only permitted rows, `getIds` requests only `_id`, `count` uses `countDocuments` without fetching data;
- `load` checks the filter with a single `findOne({ $and: [{ _id }, filter] })` and, with `read_fields`, asks Mongo only for the allowed fields (projection);
- `sync` checks a changed document with one `findOne` that already includes the access filter;
- `{}` grants and `fullaccess` are decided without touching the database at all.

This is the only read path — there is no per-row fallback, so `skip` / `limit` always page over permitted rows.

Add normal Mongo indexes for the fields your access filters use (`master`, `dep`, ...) — the access condition is part of the query, so it benefits from indexes like any other condition.

## Named methods

Custom RPC methods (see the server README) check access themselves:

```js
import { accessAllows } from "@db-state/server-mongo"

accessAllows(user.access, "bill", "write")            // any access at all?
accessAllows(user.access, "zad", "read", doc, user)   // access to this document?
```

## Service tables

`_user` and `_group` follow the same rules. Expose them in `tables` explicitly when the admin UI needs them, and grant access like any other table:

```js
{ _id: "admin", access: { _user: { read: {}, write: {} }, _group: { read: {}, write: {} } } }
```

Be careful granting non-admin groups `write` on `_group` — they could grant themselves new rights. Because groups are a normal db-state table, an admin UI can edit `access` objects at runtime; changes apply to each user at their next login or reconnect.

## Beyond filters

When a rule cannot be expressed as a data filter — external ACLs, cross-document checks, custom field projections per role — use a [hook](hooks.md). `beforeRead` / `beforeWrite` run first, may rewrite the query, set `ctx.fields`, and allow or deny outright.
