# @db-state/server-files

Модуль upload/download файлов для `@db-state/server-mongo`.

Он работает поверх того же WebSocket, что и db-state. JSON control-сообщения
идут в namespace `dbfile:*`, а содержимое файла передается binary frames с
backpressure от сервера.

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

`storage: "./uploads"` создает local storage:

```text
uploads/
  tmp/<uploadId>.tmp
  files/ab/cd/<random>.file
```

Модуль автоматически добавляет таблицу `file`. Владелец видит metadata через
`state.file`, но `storageKey` никогда не отдается клиенту. Прямые записи в
таблицу `file` запрещены; public v1 API дает upload и download, а delete/policy
helpers зарезервированы для следующего file API.

Доступ к скачиванию проверяется как `token + downloadPolicy`:

- `public`: нужен только token;
- `registered`: token плюс авторизованный пользователь;
- `verified`: token плюс verified email/phone на пользователе;
- `groups`: token плюс участие в одной из групп.

Полная документация: [docs/ru/files.md](https://github.com/efrivan84-creator/db-state/blob/main/docs/ru/files.md).
