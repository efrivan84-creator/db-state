# @db-state/vue-files

Vue-клиент для upload/download файлов поверх `@db-state/vue`.

Он использует существующий db-state WebSocket и автоматически регистрирует
`state.file`, если таблица еще не подключена.

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

Optional `key` участвует в `state.getKeyRef(key)`, поэтому одна форма может
показывать общий progress для передачи файла и следующей записи через db-state.

Полная документация: [docs/ru/files.md](https://github.com/efrivan84-creator/db-state/blob/main/docs/ru/files.md).
