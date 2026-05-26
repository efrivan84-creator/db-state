# @db-state/vue-files

Vue client file upload/download module for `@db-state/vue`.

It uses the existing db-state WebSocket and automatically registers `state.file`
when the table is not present yet.

```js
import { createFileClient } from "@db-state/vue-files"

const files = createFileClient(state)

const uploaded = await files.upload(file, {
  key: "message-form",
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

The optional `key` participates in `state.getKeyRef(key)`, so one form can show
combined progress for file transfer and the following db-state write.
