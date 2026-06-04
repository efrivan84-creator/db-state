# Аутентификация

> [English](../../en/client/authentication.md) · **Русский**

Клиент поддерживает логин по паролю, восстановление по hash, auto-auth при старте и локальный logout.

## Login

```js
await state.login("admin", "admin")
```

`login()` отправляет системное сообщение `dbstate:login`. После успеха клиент сохраняет `userId` и `hash`, выставляет `state.auth.status = "authorized"` и начинает работать с защищенными RPC.

При логине под новым пользователем клиент очищает локальные документы/query cache и переносит `time1` к моменту логина. Это защищает от показа данных прошлого пользователя.

## Hash reconnect

```js
await state.authByHash()
```

Если в storage есть `userId` и `hash`, клиент отправляет `dbstate:auth`. При успехе он не сбрасывает cache: это путь восстановления старой сессии, а не смены пользователя. После auth выполняется sync от сохраненного cursor.

## Auto-auth

```js
const state = createDbState({
  tables: ["order"],
  wsUrl,
  autoAuth: true
})
```

Auto-auth включен по умолчанию. При старте клиент:

1. Создает socket.
2. Читает saved credentials.
3. Переводит auth в `restored`, если credentials есть.
4. После открытия socket пробует `authByHash()`.
5. После authorization ретраит cache-missed reactive reads.

## Auth states

| State | Значение |
|---|---|
| `anonymous` | Credentials нет, пользователь не авторизован. |
| `restored` | Credentials есть локально, socket еще не подтвердил hash. |
| `authorizing` | Идет `login` или `authByHash`. |
| `authorized` | Socket авторизован, protected RPC доступны. |
| `error` | Последний auth flow завершился ошибкой. |

Reactive reads могут показывать cache в `restored`, но server RPC ждут `authorized`.

## Logout

```js
await state.logout()
```

Клиент отправляет `dbstate:logout`, забывает local credentials и переводит auth в anonymous. Сервер не ротирует `_user.hash`, поэтому другие вкладки и устройства не разлогиниваются.

Logout везде делается на сервере ротацией `_user.hash`.

## Смена пользователя на одном устройстве

Используй `login()` нового пользователя. Он сбросит локальную базу и in-memory state перед авторизацией, чтобы документы старого пользователя не мелькнули в новом session.

## Storage keys

По умолчанию:

| Данные | Storage |
|---|---|
| `userId` | `localStorage` |
| auth `hash` | `localStorage` |
| `time1` | `localStorage` |
| `sessionId` | `sessionStorage` |

Кэш документов хранится в выбранном cache backend, обычно IndexedDB.

## Multi-tab behavior

Каждая вкладка имеет свой `sessionId`. Поэтому собственные writes не приходят назад в ту же вкладку через sync, но другие вкладки того же пользователя получают changes.

`_user.hash` общий для пользователя. Логин во второй вкладке не инвалидирует первую.

## Custom session id

Можно передать свой `sessionId`, если нужно связать клиент с внешней telemetry/session model:

```js
createDbState({
  tables,
  wsUrl,
  sessionId: "browser-tab-123"
})
```

Он должен быть уникален для вкладки, иначе echo suppression начнет скрывать чужие изменения.

## Custom password hasher

Password hashing настраивается на сервере, не на клиенте. Клиент всегда отправляет login/password по WebSocket system flow.

## Anonymous reads

Обычные RPC до authorization отклоняются. Если нужны публичные данные, сделай server-side custom event/HTTP endpoint или осознанно авторизуй anonymous user через свою socket integration.
