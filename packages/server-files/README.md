# @db-state/server-files

File upload/download module for `@db-state/server-mongo`.

It mounts on the same WebSocket as db-state. JSON control messages use the
`dbfile:*` namespace, while file contents are sent as binary frames with
server-driven backpressure.

```js
import { createFileModule } from "@db-state/server-files"

const files = createFileModule({
  storage: "./uploads",
  maxSize: 50 * 1024 * 1024,
  chunkSize: 512 * 1024,
  defaultPolicy: { mode: "registered" }
})

const dbState = createDbStateServer({
  mongo,
  tables: ["message"],
  files
})
```

`storage: "./uploads"` creates local storage:

```text
uploads/
  tmp/<uploadId>.tmp
  files/ab/cd/<random>.file
```

The module automatically adds the `file` table. Who sees its rows is decided by
group access (e.g. `{ file: { read: { ownerId: "$adminid" } } }`); `storageKey` and
`sha256` never reach clients, in `sync` included.

Identical files are stored once. When the client sends the file's SHA-256 and
the same file is already stored, no bytes are transferred: the uploader gets a
new row and token pointing to the stored object. Knowing a stored file's hash is
enough to obtain it, so the hash never leaves the server; `dedupe: false` turns
this off.
Direct `file` table writes are denied; the public v1 API exposes upload and
download, while delete/policy helpers are reserved for a later file API.

Download access is `token + downloadPolicy`:

- `public`: token only;
- `registered`: token plus authenticated user;
- `verified`: token plus email/phone verification flags on the authenticated user;
- `groups`: token plus membership in one of the configured groups.

Full documentation: [docs/en/files.md](https://github.com/efrivan84-creator/db-state/blob/main/docs/en/files.md).
