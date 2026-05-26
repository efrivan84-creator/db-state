# Файлы

Файлы в db-state вынесены в два optional пакета:

- `@db-state/server-files` для Node/Mongo сервера;
- `@db-state/vue-files` для Vue клиента.

Они работают поверх того же физического WebSocket, что и обычный db-state. Обычные RPC/sync сообщения используют namespace `dbstate:*`. Файловый слой использует JSON control-сообщения `dbfile:*`, а сами чанки передаются raw binary WebSocket frames.

Главная схема:

```text
Vue File object
  -> dbfile:upload_start JSON
  -> сервер просит один chunk
  -> binary chunk
  -> сервер просит следующий chunk
  -> local/object storage
  -> строка file в MongoDB
  -> token возвращается клиенту
```

Metadata файла хранится как обычная db-state таблица `file`. Сам бинарь не читается через обычные права таблицы. Скачивание бинаря проверяется отдельно: capability token плюс `downloadPolicy`.

## Установка

```sh
npm install @db-state/vue @db-state/server-mongo
npm install @db-state/vue-files @db-state/server-files
```

## Настройка сервера

```js
import { WebSocketServer } from "ws"
import { MongoClient } from "mongodb"
import { createDbStateServer } from "@db-state/server-mongo"
import { createFileModule } from "@db-state/server-files"

const mongo = (await new MongoClient(process.env.MONGO_URI).connect()).db("app")

const files = createFileModule({
  storage: "./uploads",
  maxSize: 50 * 1024 * 1024,
  chunkSize: 512 * 1024,
  defaultPolicy: { mode: "registered" }
})

const dbState = createDbStateServer({
  mongo,
  tables: ["message", "chat"],
  files
})

new WebSocketServer({ port: 8788, path: "/db-state/ws" })
  .on("connection", (ws) => dbState.socket.addClient(ws))
```

`createDbStateServer({ files })` подключает файловый модуль к тому же серверу. Он автоматически:

- добавляет таблицу `file` в список разрешенных таблиц;
- объединяет file access rules с серверным access config;
- обрабатывает `dbfile:*` JSON-сообщения до обычного RPC;
- передает non-JSON raw frames файловому модулю;
- запускает cleanup файла при закрытии socket.

## Настройка клиента

```js
import { createDbState } from "@db-state/vue"
import { createFileClient } from "@db-state/vue-files"

export const state = createDbState({
  tables: ["message", "chat"],
  wsUrl: "ws://127.0.0.1:8788/db-state/ws"
})

export const files = createFileClient(state)
```

`createFileClient(state)` автоматически регистрирует `state.file`, если таблица еще не подключена. Metadata файлов можно читать обычным реактивным API:

```js
const myFiles = state.file.listRef({ sort: { "info.makedata": -1 } })
const file = state.file.load(fileId)
```

Таблица `file` нужна для личного списка файлов владельца и UI metadata. Она не является уровнем авторизации скачивания бинаря.

## Документ file

Сервер хранит строку файла так:

```ts
type FileRecord = {
  _id: string
  ownerId: string
  token?: string
  name: string
  mime: string
  size: number
  storageKey: string
  status: "uploading" | "ready" | "failed"
  downloadPolicy: DownloadPolicy
  info?: Record<string, unknown>
}
```

Поля:

| Поле | Значение |
|---|---|
| `_id` | Внутренний id строки file. Возвращается как `uploaded.id`. |
| `ownerId` | User id пользователя, который загрузил файл. Владелец читает свою metadata. |
| `token` | Capability token. Выдается только после успешного завершения upload. |
| `name` | Оригинальное имя для UI/download. Не используется как имя файла на сервере. |
| `mime` | MIME type от браузера/клиента, обычно `file.type`. |
| `size` | Финальный размер бинаря в байтах. |
| `storageKey` | Внутренний ключ storage. Скрыт от клиента через projection. |
| `status` | Состояние upload lifecycle. |
| `downloadPolicy` | Второй слой доступа к скачиванию. |
| `info` | Обычная server-owned metadata db-state для создания/редактирования. |

Клиент видит только безопасные поля:

```js
ownerId
token
name
mime
size
status
downloadPolicy
info
```

`storageKey` специально не отдается клиенту.

## Local Storage Layout

При настройке:

```js
createFileModule({ storage: "./uploads" })
```

встроенный local adapter хранит файлы так:

```text
uploads/
  tmp/
    <uploadId>.tmp
  files/
    ab/
      cd/
        <random>.file
```

Правила:

- незавершенные uploads имеют расширение `.tmp`;
- готовые файлы имеют расширение `.file`;
- имя готового файла случайное;
- оригинальное имя хранится только в `file.name`;
- `storageKey` относительный к storage root;
- клиент не получает `storageKey`.

Разбиение директорий `ab/cd` нужно, чтобы в одной папке не копилось слишком много файлов.

## Upload API

```js
const uploaded = await files.upload(file, {
  key: "message-form",
  policy: { mode: "registered" },
  onProgress(progress) {
    console.log(progress.loaded, progress.total, progress.percent)
  }
})

await state.message.add({
  chatId,
  text,
  file: [uploaded.token]
}, "message-form")
```

Результат:

```ts
type UploadResult = {
  id: string
  token: string
  file: FileRecord
}
```

Options:

| Option | Значение |
|---|---|
| `key` | Интеграция с `state.getKeyRef(key)` для progress формы/страницы. |
| `name` | Переопределяет `file.name`. |
| `mime` | Переопределяет `file.type`. |
| `policy` | Download policy для файла. Если нет, используется серверный `defaultPolicy`. |
| `onProgress` | Получает `{ loaded, total, percent }`. |

Поведение upload:

1. Клиент отправляет `dbfile:upload_start`.
2. Сервер проверяет авторизацию и размер.
3. Сервер создает строку `file` со `status: "uploading"`.
4. Сервер отправляет `dbfile:upload_next`.
5. Клиент отправляет один binary chunk.
6. Сервер записывает chunk и просит следующий.
7. Когда все байты пришли, сервер переносит `.tmp` в случайный `.file`.
8. Сервер обновляет строку до `status: "ready"` и генерирует `token`.
9. Сервер возвращает `dbfile:upload_done`.

Если socket закрывается во время upload, v1 ставит строке `status: "failed"` и удаляет временный `.tmp` файл.

## Download API

```js
const blob = await files.download(token, {
  chunkSize: 512 * 1024,
  onProgress(progress) {
    console.log(progress.loaded, progress.total, progress.percent)
  }
})
```

Options:

| Option | Значение |
|---|---|
| `key` | Интеграция с `state.getKeyRef(key)`. |
| `chunkSize` | Запрошенный размер download chunk. Сервер валидирует значение и может использовать default. |
| `onProgress` | Получает `{ loaded, total, percent }`. |

Возвращаемый `Blob` получает MIME type из строки файла.

URL для route:

```js
files.url(token) // /f/<token>
```

`files.url(token)` только форматирует строку URL. Он не создает HTTP endpoint. Обычный вариант: сделать Vue route `/f/:token`, вызвать `files.download(token)` и показать login UI, если policy требует авторизацию.

## Download Policy

```ts
type DownloadPolicy =
  | { mode: "public" }
  | { mode: "registered" }
  | { mode: "verified"; verified?: "email" | "phone" | "any" | "both" }
  | { mode: "groups"; groups: string[] }
```

Режимы:

| Mode | Требование |
|---|---|
| `public` | Только token. Login не нужен. |
| `registered` | Token плюс авторизованный пользователь. |
| `verified` | Token плюс авторизованный пользователь с verification flags. |
| `groups` | Token плюс пользователь в одной из групп. |

`verified` проверяет поля текущего socket user:

```js
client.user.emailVerified
client.user.phoneVerified
```

Серверная авторизация копирует эти поля из `_user` в `client.user`, если они есть.

Примеры:

```js
{ mode: "public" }
{ mode: "registered" }
{ mode: "verified", verified: "email" }
{ mode: "verified", verified: "both" }
{ mode: "groups", groups: ["manager", "admin"] }
```

Token обязателен всегда. Policy - второй слой доступа.

## Доступ к `state.file`

Файловый модуль добавляет access rules для таблицы `file`:

- владелец читает metadata своих файлов;
- владелец видит `token` как metadata только у готового файла;
- `storageKey` всегда скрыт;
- прямые write операции запрещены, кроме внутренних вызовов файлового модуля.

Эти вызовы отклоняются для обычного клиента:

```js
await state.file.add(...)
await state.file.update(...)
await state.file.remove(...)
```

Текущий public file API:

```js
await files.upload(file, options)
await files.download(token, options)
files.url(token)
```

`delete` и `updatePolicy` helpers в v1 еще не реализованы. Если они нужны раньше официального API, делай server-side domain action, который выполнит internal db-state/file-storage операцию со своими access rules.

## WebSocket Protocol

Один socket несет два namespace:

- `dbstate:*` для auth/RPC/sync;
- `dbfile:*` для file control messages.

Upload:

```text
client -> JSON   { type: "dbfile:upload_start", id, name, mime, size, policy }
server -> JSON   { type: "dbfile:upload_next", id, offset, chunkSize }
client -> binary <chunk bytes>
server -> JSON   { type: "dbfile:upload_next", id, offset, chunkSize }
client -> binary <chunk bytes>
server -> JSON   { type: "dbfile:upload_done", id, fileId, token, file }
```

Download:

```text
client -> JSON   { type: "dbfile:download_start", id, token, chunkSize }
server -> JSON   { type: "dbfile:download_info", id, name, mime, size }
server -> binary <chunk bytes>
client -> JSON   { type: "dbfile:download_next", id, offset }
server -> binary <chunk bytes>
server -> JSON   { type: "dbfile:download_done", id, name, mime, size }
```

Ошибки:

```text
server -> JSON { type: "dbfile:error", id, error }
```

Backpressure:

- upload управляется сервером: клиент отправляет chunk только после `upload_next`;
- download управляется клиентом: сервер отправляет следующий chunk только после `download_next`;
- v1 допускает один active upload и один active download на socket;
- active transfers сбрасываются при disconnect.

## Server API Reference

```ts
function createFileModule(options: FileModuleOptions): FileModule
function localFileStorage(root: string): FileStorage
```

`FileModuleOptions`:

| Option | Default | Значение |
|---|---:|---|
| `table` | `"file"` | Mongo collection/table для file metadata. |
| `storage` | required | Local root path string или custom `FileStorage`. |
| `maxSize` | `50 * 1024 * 1024` | Максимальный upload size в байтах. |
| `chunkSize` | `512 * 1024` | Размер upload chunk, который просит сервер. |
| `defaultPolicy` | `{ mode: "registered" }` | Policy, если upload не передал свою. |

`FileStorage` adapter:

```ts
interface FileStorage {
  tmpKey(uploadId: string): string
  writeChunk(input: {
    uploadId: string
    index: number
    offset: number
    chunk: Uint8Array
  }): Promise<void>
  finish(input: {
    uploadId: string
  }): Promise<{ storageKey: string; size: number; sha256?: string }>
  read(input: {
    storageKey: string
    range?: { start: number; end?: number }
  }): AsyncIterable<Uint8Array>
  remove(input: { storageKey: string }): Promise<void>
  abort(input: { uploadId: string }): Promise<void>
}
```

Задачи adapter:

- `tmpKey` возвращает временный key для upload id;
- `writeChunk` записывает полученный chunk;
- `finish` атомарно переводит temp upload в final storage и возвращает final `storageKey`;
- `read` отдает байты для requested range;
- `remove` удаляет готовый объект;
- `abort` удаляет незавершенный temp upload.

Встроенный local adapter подходит для разработки и single-node deployment. Для S3, MinIO, cloud storage или multi-node deployment нужен custom adapter.

## Client API Reference

```ts
function createFileClient(state, options?): FileClient
```

Options:

| Option | Default | Значение |
|---|---:|---|
| `table` | `"file"` | Имя таблицы для регистрации на клиенте. |
| `urlPrefix` | `"/f"` | Prefix для `files.url(token)`. |

`FileClient`:

```ts
interface FileClient {
  upload(file: Blob & { name?: string }, options?: UploadOptions): Promise<UploadResult>
  download(token: string, options?: DownloadOptions): Promise<Blob>
  url(token: string): string
}
```

Progress:

```ts
type FileProgress = {
  loaded: number
  total: number
  percent: number
}
```

## Loading Keys

Upload и download могут участвовать в `state.getKeyRef(key)`:

```js
const loading = state.getKeyRef("message-form")

await files.upload(file, { key: "message-form" })
await state.message.add({ text, file: [token] }, "message-form")
```

Так одна форма может показывать общий activity/progress для:

- upload файла;
- записи metadata/сообщения в базу;
- последующих реактивных загрузок из БД.

## Частые сценарии

### Вложение в чат

```js
const uploaded = await files.upload(file, {
  key: "message-form",
  policy: { mode: "groups", groups: [`chat:${chatId}`] }
})

await state.message.add({
  chatId,
  text,
  file: [uploaded.token]
}, "message-form")
```

Сообщение хранит только tokens. Один загруженный файл можно переиспользовать в нескольких документах без дублирования бинаря.

### Публичная ссылка

```js
const uploaded = await files.upload(file, {
  policy: { mode: "public" }
})

const url = files.url(uploaded.token)
```

Сделай Vue route `/f/:token`, затем вызови:

```js
await files.download(route.params.token)
```

### Личный список файлов

```js
const myFiles = state.file.listRef({
  sort: { "info.makedata": -1 },
  limit: 100
})
```

Серверное file access rule вернет только файлы текущего владельца.

## Эксплуатация

Рекомендуемые MongoDB indexes:

```js
await mongo.collection("file").createIndex({ ownerId: 1, status: 1 })
await mongo.collection("file").createIndex({ token: 1 }, { unique: true, sparse: true })
await mongo.collection("file").createIndex({ "info.makedata": -1 })
```

Рекомендации:

- не отдавай storage directory как static HTTP folder;
- делай backup metadata и binary storage вместе;
- мониторь cleanup временных uploads;
- для multi-node deployment используй object/shared storage;
- явно задавай `maxSize` для публичных приложений.

## Текущие ограничения

v1 специально маленькая:

- нет resumable upload после reconnect;
- один active upload и один active download на socket;
- нет официальных `files.delete` и `files.updatePolicy` client helpers;
- встроенный storage только local filesystem;
- нет встроенного virus scanning или MIME sniffing;
- нет встроенной генерации thumbnails;
- нет HTTP range/download endpoint; скачивание идет через WebSocket file API.

Это extension points, а не блокеры. Metadata table, hooks, server access rules и custom `FileStorage` adapter уже позволяют добавить доменное поведение в application code.
