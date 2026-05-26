# Files

db-state keeps file support in two optional packages:

- `@db-state/server-files` for the Node/Mongo server side;
- `@db-state/vue-files` for the Vue client side.

The file modules run on top of the same physical WebSocket as db-state. Normal database RPC/sync messages continue to use the `dbstate:*` namespace. File transfer uses `dbfile:*` JSON control messages plus raw binary WebSocket frames for chunks.

The core idea:

```text
Vue file object
  -> dbfile:upload_start JSON
  -> server requests one chunk
  -> binary chunk
  -> server requests next chunk
  -> local/object storage
  -> file row in MongoDB
  -> token returned to client
```

File metadata is a normal db-state table named `file`. The binary file itself is not read through normal table permissions. Binary download is controlled by a capability token plus a download policy.

## Install

```sh
npm install @db-state/vue @db-state/server-mongo
npm install @db-state/vue-files @db-state/server-files
```

## Server Setup

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

`createDbStateServer({ files })` mounts the file module into the same server. It automatically:

- adds the `file` table to the allowed table set;
- merges file access rules into the server access config;
- listens for `dbfile:*` JSON messages before normal RPC handling;
- forwards non-JSON raw frames to the file module;
- runs file cleanup when a socket closes.

## Client Setup

```js
import { createDbState } from "@db-state/vue"
import { createFileClient } from "@db-state/vue-files"

export const state = createDbState({
  tables: ["message", "chat"],
  wsUrl: "ws://127.0.0.1:8788/db-state/ws"
})

export const files = createFileClient(state)
```

`createFileClient(state)` automatically registers `state.file` if it does not already exist. That means file metadata can be read through the normal reactive db-state API:

```js
const myFiles = state.file.listRef({ sort: { "info.makedata": -1 } })
const file = state.file.load(fileId)
```

The file table is useful for the owner's file list and UI metadata. It is not the binary download authorization layer.

## File Document

The server stores a file row like this:

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

Fields:

| Field | Meaning |
|---|---|
| `_id` | Internal file row id. Returned as `uploaded.id`. |
| `ownerId` | User id that uploaded the file. Owners can read their metadata. |
| `token` | Capability token returned only when upload finishes successfully. |
| `name` | Original display/download name. It is never used as the server filename. |
| `mime` | Browser/client MIME type, usually `file.type`. |
| `size` | Final binary size in bytes. |
| `storageKey` | Internal storage key. Hidden from clients by file access projection. |
| `status` | Upload lifecycle state. |
| `downloadPolicy` | Second-layer access rule for binary download. |
| `info` | Normal db-state server-owned create/edit metadata. |

Clients can see owner-safe fields only:

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

`storageKey` is intentionally not exposed.

## Local Storage Layout

With:

```js
createFileModule({ storage: "./uploads" })
```

the built-in local adapter stores files as:

```text
uploads/
  tmp/
    <uploadId>.tmp
  files/
    ab/
      cd/
        <random>.file
```

Rules:

- temporary uploads use `.tmp`;
- finished files use `.file`;
- finished filenames are random;
- the original filename is stored only in `file.name`;
- `storageKey` is relative to the storage root;
- the client never receives `storageKey`.

The directory sharding (`ab/cd`) keeps large folders from becoming too dense.

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

Return value:

```ts
type UploadResult = {
  id: string
  token: string
  file: FileRecord
}
```

Options:

| Option | Meaning |
|---|---|
| `key` | Optional `state.getKeyRef(key)` integration. Useful for form/page progress. |
| `name` | Overrides `file.name`. |
| `mime` | Overrides `file.type`. |
| `policy` | Download policy stored on the file. Defaults to server `defaultPolicy`. |
| `onProgress` | Called with `{ loaded, total, percent }`. |

Upload behavior:

1. Client sends `dbfile:upload_start`.
2. Server verifies auth and size.
3. Server creates a `file` row with `status: "uploading"`.
4. Server sends `dbfile:upload_next`.
5. Client sends one binary chunk.
6. Server appends the chunk and requests the next one.
7. When all bytes arrive, server moves `.tmp` to a random `.file`.
8. Server updates the row to `status: "ready"` and generates `token`.
9. Server returns `dbfile:upload_done`.

If the socket closes while uploading, v1 marks the row as `failed` and removes the temporary `.tmp` file.

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

| Option | Meaning |
|---|---|
| `key` | Optional `state.getKeyRef(key)` integration. |
| `chunkSize` | Requested download chunk size. Server validates it and may use its default. |
| `onProgress` | Called with `{ loaded, total, percent }`. |

The returned `Blob` uses the MIME type stored in the file row.

To create a route-friendly URL:

```js
files.url(token) // /f/<token>
```

`files.url(token)` only formats a URL string. It does not add an HTTP download endpoint by itself. A typical app can route `/f/:token` to a Vue page, call `files.download(token)`, and show login UI if the policy requires auth.

## Download Policy

```ts
type DownloadPolicy =
  | { mode: "public" }
  | { mode: "registered" }
  | { mode: "verified"; verified?: "email" | "phone" | "any" | "both" }
  | { mode: "groups"; groups: string[] }
```

Policy modes:

| Mode | Requirement |
|---|---|
| `public` | Token only. No login required. |
| `registered` | Token plus authenticated user. |
| `verified` | Token plus authenticated user with verification flags. |
| `groups` | Token plus authenticated user in at least one configured group. |

`verified` checks the authenticated socket user:

```js
client.user.emailVerified
client.user.phoneVerified
```

The server auth layer copies these fields from `_user` into `client.user` when they exist.

Examples:

```js
{ mode: "public" }
{ mode: "registered" }
{ mode: "verified", verified: "email" }
{ mode: "verified", verified: "both" }
{ mode: "groups", groups: ["manager", "admin"] }
```

Token is always required. Policy is the second layer.

## `state.file` Access

The file module adds access rules for the `file` table:

- owner can read their own file metadata;
- owner can see `token` only as a metadata field after the file is ready;
- `storageKey` is always hidden;
- direct writes are denied unless the call is an internal file-module write.

These calls are rejected for normal clients:

```js
await state.file.add(...)
await state.file.update(...)
await state.file.remove(...)
```

Current public file API is:

```js
await files.upload(file, options)
await files.download(token, options)
files.url(token)
```

`delete` and `updatePolicy` helpers are not implemented in v1. If the application needs them before they become official API, implement a server-side domain action that performs an internal db-state/file-storage operation with your own access rules.

## WebSocket Protocol

The same socket carries two namespaces:

- `dbstate:*` for db-state auth/RPC/sync;
- `dbfile:*` for file control messages.

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

Errors:

```text
server -> JSON { type: "dbfile:error", id, error }
```

Backpressure:

- upload is server-driven: the client sends a chunk only after `upload_next`;
- download is client-driven: the server sends the next chunk only after `download_next`;
- v1 allows one active upload and one active download per socket;
- active transfers are discarded on disconnect.

## Server API Reference

```ts
function createFileModule(options: FileModuleOptions): FileModule
function localFileStorage(root: string): FileStorage
```

`FileModuleOptions`:

| Option | Default | Meaning |
|---|---:|---|
| `table` | `"file"` | Mongo collection/table for file metadata. |
| `storage` | required | Local root path string or custom `FileStorage`. |
| `maxSize` | `50 * 1024 * 1024` | Max upload size in bytes. |
| `chunkSize` | `512 * 1024` | Server-requested upload chunk size. |
| `defaultPolicy` | `{ mode: "registered" }` | Policy used when upload does not provide one. |

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

Adapter responsibilities:

- `tmpKey` returns the temporary storage key for an upload id;
- `writeChunk` appends or writes the received chunk;
- `finish` atomically promotes a temp upload into final storage and returns the final `storageKey`;
- `read` yields bytes for the requested range;
- `remove` deletes a finished object;
- `abort` deletes an unfinished temp upload.

The built-in local adapter is enough for development and single-node deployments. For S3, MinIO, cloud storage, or multi-node deployments, use a custom adapter.

## Client API Reference

```ts
function createFileClient(state, options?): FileClient
```

Options:

| Option | Default | Meaning |
|---|---:|---|
| `table` | `"file"` | Table name to register on the client. |
| `urlPrefix` | `"/f"` | Prefix used by `files.url(token)`. |

`FileClient`:

```ts
interface FileClient {
  upload(file: Blob & { name?: string }, options?: UploadOptions): Promise<UploadResult>
  download(token: string, options?: DownloadOptions): Promise<Blob>
  url(token: string): string
}
```

Progress object:

```ts
type FileProgress = {
  loaded: number
  total: number
  percent: number
}
```

## Loading Keys

Both upload and download can participate in `state.getKeyRef(key)`:

```js
const loading = state.getKeyRef("message-form")

await files.upload(file, { key: "message-form" })
await state.message.add({ text, file: [token] }, "message-form")
```

This lets one form display a shared activity/progress state for:

- file upload;
- metadata/database write;
- later reactive database loads.

## Common Patterns

### Chat Attachment

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

The message stores only file tokens. The same uploaded file can be reused in several documents without duplicating binary data.

### Public Link

```js
const uploaded = await files.upload(file, {
  policy: { mode: "public" }
})

const url = files.url(uploaded.token)
```

Build a Vue route for `/f/:token`, then call:

```js
await files.download(route.params.token)
```

### Owner File List

```js
const myFiles = state.file.listRef({
  sort: { "info.makedata": -1 },
  limit: 100
})
```

The server-side file access rule returns only files owned by the current user.

## Operational Notes

Recommended MongoDB indexes:

```js
await mongo.collection("file").createIndex({ ownerId: 1, status: 1 })
await mongo.collection("file").createIndex({ token: 1 }, { unique: true, sparse: true })
await mongo.collection("file").createIndex({ "info.makedata": -1 })
```

Recommended deployment rules:

- do not expose the storage directory as a static HTTP folder;
- back up metadata and binary storage together;
- monitor temp upload cleanup;
- use object storage or shared storage for multi-node deployments;
- keep `maxSize` explicit for public-facing apps.

## Current Limitations

v1 intentionally stays small:

- no resumable upload after reconnect;
- one active upload and one active download per socket;
- no official `files.delete` or `files.updatePolicy` client helper yet;
- built-in storage is local filesystem only;
- no built-in virus scanning or MIME sniffing;
- no built-in image thumbnail generation;
- no HTTP range/download endpoint; downloads use the WebSocket file API.

These are extension points, not blockers. The metadata table, hooks, server access rules, and custom `FileStorage` adapter are already enough to add domain-specific behavior in application code.
