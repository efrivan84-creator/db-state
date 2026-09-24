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

Модуль автоматически добавляет таблицу `file`. Кто видит её строки, решают права
группы (например `{ file: { read: { ownerId: "$adminid" } } }`); `storageKey` и
`sha256` клиенту не уходят никогда, в `sync` тоже.

Одинаковые файлы хранятся один раз. Если клиент прислал SHA-256 и такой файл
уже лежит, байты не передаются: загрузивший получает новую строку и token на
тот же объект. Знания хэша лежащего файла достаточно, чтобы его получить,
поэтому хэш не покидает сервер; `dedupe: false` выключает дедупликацию. Прямые записи в
таблицу `file` запрещены; public v1 API дает upload и download, а delete/policy
helpers зарезервированы для следующего file API.

Доступ к скачиванию проверяется как `token + downloadPolicy`:

- `public`: нужен только token;
- `registered`: token плюс авторизованный пользователь;
- `verified`: token плюс verified email/phone на пользователе;
- `groups`: token плюс участие в одной из групп.

Полная документация: [docs/ru/files.md](https://github.com/efrivan84-creator/db-state/blob/main/docs/ru/files.md).
