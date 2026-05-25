# Server authentication

The server handles three auth messages over the WebSocket: `dbstate:login`, `dbstate:auth` (hash reconnect), and `dbstate:logout`. All three are processed by `auth.js` independently of the RPC dispatcher.

## The `_user` table

Each user is a Mongo document:

```js
{
  _id: "u_123",                 // any unique string
  login: "ivan",                // optional login identifier
  email: "ivan@example.com",    // optional identifier
  phone: "+79990001122",        // optional identifier
  passwordHash: "pbkdf2:...",   // see "Password adapters" below
  hash: "abc...",               // auth secret, server-managed
  groups: ["manager"],          // optional, used by permissions
  disabled: false,              // optional, blocks login if true
  // ...any other fields you want
}
```

The library reads `passwordHash`, `hash`, `groups`, `disabled`, and the fields configured by `authLoginFields`. Anything else is your app's data.

To create a user:

```js
import { defaultPassword } from "@db-state/server-mongo"

await mongo.collection("_user").insertOne({
  _id: "u_admin",
  login: "admin",
  passwordHash: await defaultPassword.hash("strong-password-here"),
  groups: ["admin"],
  disabled: false
})
```

## Login flow

Client sends:

```json
{ "type": "dbstate:login", "id": "msg1", "login": "ivan", "password": "..." }
```

Server:

1. Finds an active `_user` by the configured login fields. Default query: `mongo.collection("_user").findOne({ login, disabled: { $ne: true } })`.
2. Verifies password via `password.verify(plain, stored)`.
3. If `_user.hash` is missing, generates one (`defaultAuthHash()` = 32 random hex bytes) and saves it.
4. Attaches `{ _id, login, groups }` to the socket as `client.user`.
5. Sends back:

```json
{
  "type": "dbstate:login_result",
  "id": "msg1",
  "ok": true,
  "userId": "u_123",
  "hash": "abc...",
  "groups": ["manager"]
}
```

On failure:

```json
{
  "type": "dbstate:login_error",
  "id": "msg1",
  "error": "Invalid login or password"
}
```

### Login by email, phone, or name

The protocol field is still named `login`, but it can contain any identifier value. Configure the server:

```js
createDbStateServer({
  mongo,
  tables: [...],
  authLoginFields: ["login", "name", "email", "phone"],
  normalizeAuthLogin: (value, field) => {
    const text = String(value).trim()
    if (field === "email") return text.toLowerCase()
    if (field === "phone") return text.replace(/\D/g, "")
    return text
  }
})
```

Then all of these can authenticate the same `_user` row if the password matches:

```js
await state.login("ivan", "...")
await state.login("Ivan Petrov", "...")
await state.login("ivan@example.com", "...")
await state.login("+79990001122", "...")
```

The server query becomes:

```js
{
  disabled: { $ne: true },
  $or: [
    { login: value },
    { name: value },
    { email: value },
    { phone: value }
  ]
}
```

Store normalized values in `_user`, too. For example, save lowercase emails and canonical phone digits.

Add sparse unique Mongo indexes for each configured identifier field in production, otherwise duplicate emails or phones can make login ambiguous:

```js
await mongo.collection("_user").createIndex({ login: 1 }, { unique: true, sparse: true })
await mongo.collection("_user").createIndex({ email: 1 }, { unique: true, sparse: true })
await mongo.collection("_user").createIndex({ phone: 1 }, { unique: true, sparse: true })
```

If a normalized identifier matches multiple active users, login fails with the same generic `Invalid login or password` response and `onAuthWarning` is called:

```js
createDbStateServer({
  mongo,
  tables: [...],
  onAuthWarning: (warning) => {
    if (warning.type === "ambiguous_auth_login") {
      console.warn("ambiguous auth login", warning.login, warning.normalized, warning.count)
    }
  }
})
```

## Login and auth rate limiting

Use `authRateLimit` to throttle public login and hash-auth attempts. Return `false` to reject with `Too many attempts`:

```js
createDbStateServer({
  mongo,
  tables: [...],
  authRateLimit: async ({ type, login, userId, client }) => {
    const key = client.ip ?? login ?? userId
    return await limiter.allow(`${type}:${key}`)
  }
})
```

## Hash auth

For reconnects and tab restores. Client sends:

```json
{ "type": "dbstate:auth", "id": "msg2", "userId": "u_123", "hash": "abc..." }
```

Server:

1. `mongo.collection("_user").findOne({ _id, hash, disabled: { $ne: true } })`.
2. If found, attaches user to socket.
3. Sends `dbstate:auth_result` with `{ ok: true, userId, groups }`.

On failure: `dbstate:auth_error`.

This means **any compromised hash gives long-term access** until the user is disabled or the hash is rotated. Treat it like a session cookie — protect via TLS, don't log it.

### Why hash and not JWT?

JWTs are stateless — you can't revoke them server-side without a separate blacklist. Hash auth is a single Mongo lookup, but it lets you instantly revoke a user by:

```js
await mongo.collection("_user").updateOne({ _id: "u_123" }, { $set: { hash: defaultAuthHash() } })
// or to disable entirely:
await mongo.collection("_user").updateOne({ _id: "u_123" }, { $set: { disabled: true } })
```

Existing connections continue with the old socket-level user until they reconnect, but their next `authByHash` fails.

If you prefer JWTs, replace the auth handling — see "Custom auth" below.

## Logout

```json
{ "type": "dbstate:logout", "id": "msg3" }
```

Server deletes `client.user` from the socket and responds:

```json
{ "type": "dbstate:logout_result", "id": "msg3", "ok": true }
```

The user's `_user.hash` is **not** rotated. To force-logout every device, rotate the hash manually:

```js
await mongo.collection("_user").updateOne(
  { _id: userId },
  { $set: { hash: defaultAuthHash() } }
)
```

## Password adapters

Default: PBKDF2-SHA256, 120k rounds, 16-byte salt.

```js
import { defaultPassword } from "@db-state/server-mongo"

const stored = await defaultPassword.hash("my-password")
// stored = "pbkdf2:<salt-hex>:<hash-hex>"

await defaultPassword.verify("my-password", stored)  // true
```

This is comparable to bcrypt at default cost — secure for typical web apps. Replace if you have specific requirements.

### Plug in bcrypt

```sh
npm install bcrypt
```

```js
import bcrypt from "bcrypt"
import { createDbStateServer } from "@db-state/server-mongo"

createDbStateServer({
  mongo,
  tables: [...],
  password: {
    hash:   (plain) => bcrypt.hash(plain, 12),
    verify: (plain, stored) => bcrypt.compare(plain, stored)
  }
})
```

### Plug in Argon2

```sh
npm install argon2
```

```js
import argon2 from "argon2"

createDbStateServer({
  mongo,
  tables: [...],
  password: {
    hash:   (plain) => argon2.hash(plain),
    verify: (plain, stored) => argon2.verify(stored, plain)
  }
})
```

### Demo-only adapter

For tests and small demos where you don't care about security:

```js
createDbStateServer({
  mongo,
  tables: [...],
  password: {
    hash:   async (plain) => `demo:${plain}`,
    verify: async (plain, stored) => stored === `demo:${plain}`
  }
})
```

**Don't use this in production.** It stores plaintext-equivalent passwords.

## Custom auth hash generation

By default `defaultAuthHash` returns 32 random hex bytes — 256 bits of entropy.

```js
import { randomBytes } from "node:crypto"

createDbStateServer({
  mongo,
  tables: [...],
  createAuthHash: () => randomBytes(48).toString("base64url")  // 384 bits
})
```

Or use a custom format (e.g. UUID-formatted, prefixed) for easier log grepping.

## Disabling a user

Set `disabled: true` on the `_user` row. Login fails (no row matches `{ disabled: { $ne: true } }`). Existing socket auth is unaffected until the next reconnect — for instant kill, rotate the hash too.

## Custom auth: bypassing dbstate:login

If you already have an auth system (OAuth, SSO, JWT), you don't have to use `dbstate:login`. Pre-authenticate the socket yourself:

```js
import jwt from "jsonwebtoken"

wss.on("connection", async (ws, req) => {
  const token = new URL(req.url, "http://x").searchParams.get("token")
  let user
  try {
    const payload = jwt.verify(token, JWT_SECRET)
    user = await mongo.collection("_user").findOne({ _id: payload.sub })
  } catch {
    ws.close(4001, "Unauthorized")
    return
  }

  dbState.socket.addClient(ws, {
    user: { _id: user._id, login: user.login, groups: user.groups ?? [] },
    userId: user._id,
    sessionId: `${user._id}_${crypto.randomUUID()}`
  })
})
```

The client opens `wss://example.com/db-state/ws?token=<JWT>`. The server validates, attaches the user, and RPCs flow normally. You don't need `_user.passwordHash` or `_user.hash` in this case — the library doesn't care **how** auth happened, only that `client.user` is set.

You can skip the `dbstate:login`/`dbstate:auth` handlers entirely by not seeding `_user` at all — but you'll need to provide `getUser` so the access layer knows who's calling:

```js
createDbStateServer({
  mongo,
  tables: [...],
  getUser: async ({ client }) => client?.user
})
```

(That's the default, but worth being explicit when bypassing `dbstate:*` auth.)

## Multi-tenancy

For multi-tenant apps where users belong to organizations:

```js
{
  _id: "u_alice",
  login: "alice@acme.com",
  passwordHash: "...",
  groups: ["acme:admin", "acme:billing"]   // namespace groups by tenant
}
```

Then your permissions and code rules can use `acme:admin` etc.

Or set a custom field:

```js
{
  _id: "u_alice",
  ...
  tenantId: "acme"
}
```

And use it in code rules:

```js
read: async (ctx) => {
  const obj = ctx.obj ?? await ctx.loadDoc?.()
  return obj?.tenantId === ctx.user?.tenantId
}
```

You'd need to extend `getUser` to load and attach `tenantId`:

```js
createDbStateServer({
  ...,
  getUser: async ({ client }) => {
    if (!client?.user) return undefined
    const fullUser = await mongo.collection("_user").findOne({ _id: client.user._id })
    return { ...client.user, tenantId: fullUser?.tenantId }
  }
})
```

(Or attach `tenantId` at login time so you don't refetch on every RPC.)

## Login throttling

The library doesn't rate-limit logins. Add your own in front:

```js
import { RateLimiterMemory } from "rate-limiter-flexible"

const loginLimiter = new RateLimiterMemory({ points: 5, duration: 60 })

wss.on("connection", (ws) => {
  ws.on("message", async (raw) => {
    const msg = JSON.parse(String(raw))
    if (msg.type === "dbstate:login") {
      try {
        await loginLimiter.consume(ws._socket.remoteAddress)
      } catch {
        ws.send(JSON.stringify({ type: "dbstate:login_error", id: msg.id, error: "Too many attempts" }))
        return
      }
    }
  })
  dbState.socket.addClient(ws)
})
```

The library's handler runs **after** your `on("message")` listener, so this works as a pre-filter. (Both handlers see the message — yours decides whether to send an error first.)
