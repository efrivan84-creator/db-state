# @db-state/vue-files

Vue client file upload/download module for `@db-state/vue`.

It uses the existing db-state WebSocket and automatically registers `state.file`
when the table is not present yet.

```js
import { createFileClient } from "@db-state/vue-files"

const files = createFileClient(state)

const uploaded = await files.upload(file, {
  policy: { mode: "registered" },
  onProgress: ({ loaded, total, percent }) => {}
})

await state.message.add({
  text,
  file: [uploaded.token]
}, "message-form")

const blob = await files.download(uploaded.token, {
  onProgress: ({ loaded, total, percent }) => {}
})

files.url(uploaded.token) // /f/<token>
```

File transfer progress is reported through `onProgress`. It is intentionally
separate from `state.getKeyRef(key)`, which remains a db-state read/write
loading helper.

Full documentation: [docs/en/files.md](https://github.com/efrivan84-creator/db-state/blob/main/docs/en/files.md).
