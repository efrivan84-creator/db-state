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

The module automatically adds the `file` table. Owners can read their file
metadata through `state.file`, but `storageKey` is never exposed to clients.
Direct `file` table writes are denied; the public v1 API exposes upload and
download, while delete/policy helpers are reserved for a later file API.

Download access is `token + downloadPolicy`:

- `public`: token only;
- `registered`: token plus authenticated user;
- `verified`: token plus email/phone verification flags on the authenticated user;
- `groups`: token plus membership in one of the configured groups.

Full documentation: [docs/en/files.md](https://github.com/efrivan84-creator/db-state/blob/main/docs/en/files.md).
