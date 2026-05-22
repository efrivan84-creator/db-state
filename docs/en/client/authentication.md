# Authentication

> **English** · [Русский](../../../ru/client/authentication.md)

The Vue client supports three flows: explicit login/password, hash-based reconnect, and automatic restore after page refresh.

## Login

```js
const result = await state.login("ivan", "mypassword")
// result.ok      = true
// result.userId  = "u_123"
// result.hash    = "abcdef..."  (auth secret)
// result.groups  = ["manager"]
```

What happens:

1. RPC `dbstate:login` over the same WebSocket.
2. Server verifies password (PBKDF2 by default), looks up `_user.hash`, creates it if missing, and assigns it to the socket.
3. Client saves `userId` + `hash` to `localStorage` (configurable storage).
4. All `countRef` / `idsRef` are refreshed.
5. State transitions: `state.auth.status` becomes `"authorized"`.

## Hash reconnect

After page refresh or reconnect, the client uses the saved hash instead of asking for a password:

```js
const ok = await state.authByHash()
// ok = true if the saved hash is still valid
```

Server flow: `dbstate:auth` RPC with `{ userId, hash }`. If valid, the socket is authorized. If the hash has been rotated server-side, the call returns an error — the client clears saved credentials and falls back to anonymous.

## Auto-auth

Enabled by default. On socket connect (initial or reconnect), the client:

1. Reads saved `userId` / `hash`.
2. If present, runs `authByHash`.
3. On success, runs `syncNow`.

```js
export const state = createDbState({
  tables: ["order"],
  autoAuth: true  // default
})
```

Disable if you want full control:

```js
createDbState({ tables: ["order"], autoAuth: false })
// Then explicitly:
state.socket.connect()
await state.login(...)
```

## Auth states

```js
state.auth.status
```

| Status | Meaning |
|---|---|
| `"anonymous"` | No credentials saved or login failed. |
| `"restored"` | Saved credentials exist; UI can show cached data while we wait for the socket. |
| `"authorizing"` | `authByHash` is in flight. |
| `"authorized"` | Confirmed by the server; RPCs allowed. |

A common UI pattern:

```vue
<template>
  <LoginForm v-if="state.auth.status === 'anonymous'" />
  <App v-else-if="state.auth.status === 'authorized'" />
  <CachedView v-else-if="state.auth.status === 'restored'" />   <!-- offline / pre-auth -->
  <Loader v-else />                                              <!-- "authorizing" -->
</template>
```

## Logout

```js
await state.logout()
```

What happens:

- Server's `dbstate:logout` clears the socket's user.
- Client's `localStorage` user/hash are removed.
- `state.auth.status` → `"anonymous"`.
- **Local data is NOT cleared** — cached docs and `time1` stay. If you want a clean slate (e.g. role switch on a kiosk), follow with `state.clearLocalDB()`.

The user's `_user.hash` on the server is **not rotated** by logout. The same user logging in elsewhere keeps that hash. To force-logout every device, rotate the hash on the server:

```js
// On the server, e.g. in a "lock account" admin action:
await mongo.collection("_user").updateOne(
  { _id: userId },
  { $set: { hash: defaultAuthHash() } }
)
```

After rotation, any client trying `authByHash` with the old hash gets an error and falls back to anonymous.

## Switching users on the same device

Common case: an admin demo where you want to log in as different roles in turn. Do this in order:

```js
// 1. Tell the server we're leaving.
if (state.auth.status !== "anonymous") {
  await state.logout()
}

// 2. Wipe all locally cached data so role A's documents don't leak to role B.
await state.clearLocalDB()

// 3. Authenticate as the new user.
await state.login("manager", "...")

// 4. Force initial sync.
await state.syncNow()
```

Don't `clearLocalDB` **before** `login` succeeds — if login fails, you've wiped the cache for nothing.

## Storage keys

By default the client uses these keys:

| Storage | Key | Contents |
|---|---|---|
| `sessionStorage` | `db-state.sessionId` | per-tab session id (used by sync to suppress echo) |
| `localStorage` | `db-state.time1` | last successful sync timestamp |
| `localStorage` | `db-state.userId` | saved auth user id |
| `localStorage` | `db-state.authHash` | saved auth hash |
| IndexedDB | `db-state` / `records` | cached documents |

Override per-app if you run multiple db-state instances on the same origin:

```js
createDbState({
  tables: ["order"],
  sessionKey: "myapp.sessionId",
  syncKey:    "myapp.time1",
  userIdKey:  "myapp.userId",
  authHashKey: "myapp.authHash",
  cache: createIndexedDbCache({ name: "myapp-cache" })
})
```

## Multi-tab behavior

Each tab gets its own `sessionId` (because `sessionStorage` is per-tab). All tabs of the same user share the same `userId` + `hash` (because `localStorage` is shared).

This means:

- Open tab A, log in. Open tab B — automatically authorized via the shared hash.
- Mutations from tab A broadcast to tab B (the server sees different `sessionId`s).
- Tab A's own mutations don't echo back to tab A (server suppresses by `sessionId`).
- Logout in tab A clears localStorage — tab B's next reconnect goes anonymous.

This last point can be surprising. If you don't want tab B to log out when tab A does, override `authStorage` per tab (e.g. use `sessionStorage` for auth too). Most apps prefer the default behavior.

## Custom session id

```js
createDbState({
  tables: ["order"],
  userId: "explicit-id"  // used in createSessionId if no session exists
})
```

By default `sessionId = "${userId}_${random10}"`. Override the prefix to make logs more grep-friendly.

## Custom password hasher

The library defaults to PBKDF2 on the server. If you want different hashing (bcrypt, argon2, etc.), see [server/authentication.md](../server/authentication.md#custom-password-adapters) — the client doesn't care which hasher you use, it only sends the plaintext password to the login RPC.

## Anonymous reads

If you have permissions that allow anonymous reads (e.g. public catalog):

```js
// _permission row:
{ table: "product", read: { users: ["__anonymous__"] } }
```

— then the client can call RPCs **without** logging in. But the default RPC handler rejects unauthenticated calls with `"Unauthorized"`. To allow it, you need a custom RPC dispatcher (see [server/api-reference.md](../server/api-reference.md#custom-handlers)) or a server middleware that injects an anonymous user.

For most apps the simpler approach is to have a `_user._id = "anonymous"` row and log in to it automatically on first visit.
