# Серверная аутентификация

> [English](../../en/server/authentication.md) · **Русский**

Серверная auth-модель основана на таблице `_user`, password hash для login и persistent hash для reconnect.

## Таблица `_user`

```js
{
  _id: "u1",
  login: "ivan",
  email: "ivan@example.com",
  phone: "+10000000000",
  passwordHash: "...",
  hash: "auth-secret",
  groups: ["manager"],
  disabled: false,
  emailVerified: true,
  phoneVerified: false
}
```

`groups` используются permissions. `hash` выдается клиенту после login и нужен для `authByHash()`.

## Login flow

```text
client -> dbstate:login { login, password }
server -> find _user
server -> verify passwordHash
server -> create/reuse hash
server -> attach user to socket
server -> dbstate:login_result { userId, hash, groups }
```

Ошибки должны быть общими: не раскрывай, существует ли пользователь.

### Login by email, phone, or name

```js
createDbStateServer({
  mongo,
  tables,
  authLoginFields: ["login", "email", "phone"],
  normalizeAuthLogin: (value, field) => {
    if (field === "email") return value.toLowerCase()
    return value.trim()
  }
})
```

Если normalized login совпал с несколькими пользователями, сервер отклонит вход и вызовет warning hook.

## Login and auth rate limiting

```js
createDbStateServer({
  mongo,
  tables,
  authRateLimit: async ({ type, login, userId }) => {
    return true
  }
})
```

Возвращай `false`, чтобы отклонить попытку.

## Hash auth

```text
client -> dbstate:auth { userId, hash }
server -> load _user
server -> compare hash
server -> attach user to socket
```

Hash общий для пользователя. Новая вкладка не сбрасывает старую.

### Почему hash, а не JWT?

Hash легко ротировать в `_user`, не нужно выпускать/проверять claims, и сервер всегда читает актуальные groups/disabled flags. Это проще для админок и B2B tools.

## Logout

Client logout забывает hash локально и отправляет `dbstate:logout`. Другие устройства не затрагиваются. Logout везде - ротация `_user.hash`.

## Password adapters

Default adapter использует PBKDF2:

```js
import { defaultPassword } from "@db-state/server-mongo"

const passwordHash = await defaultPassword.hash("secret")
```

### bcrypt

```js
import bcrypt from "bcryptjs"

createDbStateServer({
  mongo,
  tables,
  password: {
    hash: (password) => bcrypt.hash(password, 12),
    verify: (password, hash) => bcrypt.compare(password, hash)
  }
})
```

### Argon2

```js
import argon2 from "argon2"

createDbStateServer({
  mongo,
  tables,
  password: {
    hash: (password) => argon2.hash(password),
    verify: (password, hash) => argon2.verify(hash, password)
  }
})
```

### Demo-only adapter

Для демо можно использовать plain compare, но не для production.

## Custom auth hash generation

```js
createDbStateServer({
  mongo,
  tables,
  authHash: {
    create: async () => crypto.randomUUID()
  }
})
```

Hash должен быть непредсказуемым.

## Отключение пользователя

Если `_user.disabled === true`, login/hash auth должны отклоняться. Для немедленного logout всех устройств дополнительно ротируй hash.

## Custom auth без `dbstate:login`

Можно авторизовать socket внешним middleware и передать metadata:

```js
dbState.socket.addClient(ws, {
  user,
  userId: user._id,
  sessionId
})
```

Тогда клиент может работать как уже authorized socket, если твой frontend тоже знает session/user.

## Multi-tenancy

Храни `tenantId` в `_user` и документах, затем добавь хук:

```js
hooks: {
  beforeRead(ctx) {
    ctx.filter = { ...ctx.filter, tenantId: ctx.user.tenantId }
  }
}
```

Не полагайся только на client filters.

## Login throttling

Ограничивай login по IP, normalized login и userId. Не логируй password и hash.
