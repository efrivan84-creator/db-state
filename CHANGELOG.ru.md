# Changelog

Описание изменений и статус проекта db-state.

## Unreleased

## 0.1.0

- **Ломающее изменение sync:** `syncLimit` и клиентский лимит числа changes удалены. Один ответ сервера покрывает не более 12 часов, `hasMore` заставляет Vue-клиент последовательно догнать все окна, а cursor старше 20 дней получает `reset: true`, после чего клиент очищает cache и перечитывает текущее состояние.
- **Ломающее изменение: реактивные документы больше не дублируют `_id` в `id`.** Каждая запись несла одно и то же значение дважды; ключ теперь только `_id` — как в Mongo и в журнале изменений. В шаблонах замените `row.id` на `row._id` (`:key`, выбор строки). Поле `id`, переданное в `add()`, по-прежнему принимается как ключ документа, а `change.id` и `UpdateArgs.id` не менялись — правка касается только самих объектов документов.
- **Ломающее изменение: code-правила доступа удалены.** Опции `createDbStateServer({ access })` больше нет — права живут только в объекте `access` групп пользователя, а динамические решения переехали в хуки. Хук `beforeRead`/`beforeWrite` теперь может вернуть `false` или `{ allowed: false, reason }` для запрета (причина уходит клиенту), `true` — разрешить и пропустить проверку группы, либо ничего — тогда решает `access` группы; правки `ctx` применяются в любом случае. `beforeRead` может выставить `ctx.fields` и сузить набор возвращаемых полей (расширить разрешённое `read_fields` нельзя). Раз code-правил нет, исчез и построчный fallback в `getIds`/`count`/`getUnique`: фильтр права всегда уходит в Mongo-запрос, поэтому `skip`/`limit` всегда листают уже разрешённые строки. Вместе с этим удалены `AccessConfig`, `AccessRule`, `canAccess` и `filterReadable`.
- **Ломающее изменение: хуки объявляются один раз на имя для всего сервера.** Вложенности по таблицам (`hooks: { order: { beforeRead } }`) больше нет — таблица разбирается внутри хука по `ctx.table`. Хуки подключённых модулей теперь выполняются перед хуком приложения с тем же именем, а не затирают его; первое явное решение останавливает цепочку.
- `errorRead` / `errorWrite` теперь срабатывают и когда запрошенной таблицы нет в `tables`: раньше ошибка бросалась до того, как хук мог её увидеть.
- Сообщения `Read denied` / `Write denied` теперь называют таблицу.
- `@db-state/server-files` больше не поставляет code-правила: таблица файлов защищена собственными хуками, `storageKey` не покидает сервер ни при каком чтении через CRUD, а права на метаданные настраиваются обычным `access` группы. Попутно исправлена ошибка: завершение загрузки читало файл обратно без внутренней пометки.
- **Ломающее изменение: `meta.accessFiltered` и `meta.denied` удалены.** Сколько строк или изменений скрыли права чтения, больше не сообщается — клиенту это не нужно, а число недоступных строк само по себе утечка. Сервер их больше и не считает, поэтому из `getUnique`/`sync`/`count` ушёл построчный подсчёт. `meta.fieldsFiltered` остался: он выводится из уже разрешённого права без дополнительной работы. Теперь в `meta` попадает только то, что серверу известно и так, — ради него ничего не считается и не перезапрашивается. Вместе с этим удалены `hasHiddenFields` и `hasHiddenChangeFields`.
- Значение `read`/`write` должно быть объектом-фильтром (или массивом фильтров как результатом слияния групп). Любое другое значение — `true`, `1`, `false`, `""`, `[]` — правом не считается и означает запрет, поэтому опечатка или старая запись в базе не могут молча расширить доступ. `accessAllows` работает по тому же правилу.
- Пользователь разрешается один раз на запрос, а не отдельно в `userReadPlan` и по разу на строку — снят N+1 для собственных реализаций `getUser`.
- Значение `read`/`write` — всегда фильтр по документу: `{}` = все строки (полный доступ к действию), `{ enable: true }` = только совпавшие; после слияния групп — any-of массив. `read_fields`/`write_fields` — белые списки полей. Единственный флаг — спецключ `fullaccess: 1`. Подстановки в фильтрах: `"$adminid"` (id пользователя) и `"$groupid"` (любая из его групп) — «свои документы» вообще без кода. `write`-фильтр проверяется по существующему документу для `update`/`remove` и по новому для `add`; sync лениво догружает документ только при фильтре. Фильтры проверяет сама база одним запросом: списки и `count` получают условие права прямо в Mongo-запрос (`count` — через `countDocuments`, без выгрузки строк), `sync` и `load` делают `findOne` сразу с фильтром, `load` с `read_fields` получает от Mongo только разрешённые поля (projection), `getIds` — только `_id`, `"$groupid"` в запросе превращается в `{ $in: группы }`. `accessAllows` принимает необязательные `doc`/`user`, добавлен экспорт `matchesAccessFilter`.
- **Ломающее изменение: таблица `_permission` удалена.** Права теперь — объект `access` на группе (`_group`): `{ zad: { read: {}, write: {} }, bill: { read: { needact: true } }, fullaccess: 1 }`. При логине сервер аддитивно сливает `access` всех групп пользователя (плюс личный `access` на `_user`), вешает его на `user.access` и возвращает в `login_result`/`auth_result`. Порядок проверки: хук `beforeRead`/`beforeWrite` → `user.access` → deny. Декларативные фильтры `read`/`write` ограничивают строки, а `read_fields`/`write_fields` — поля; хуки остаются для динамических, внешних и междокументных решений. `read` покрывает `load/getIds/getUnique/count` и видимость `sync`; `write` — `add/update/remove`. Новые экспорты: `accessAllows(access, table, action)`, `matchesAccessFilter` и `mergeUserAccess`. Заодно исчез N+1 запрос к `_permission` в `getIds`/`count` и кэш правил в `sync`.
- `@db-state/server-mongo`: `createDbStateServer({ methods })` регистрирует свои именованные RPC-методы в том же WebSocket-роутере, что и встроенные CRUD/sync; модули (`files`) могут добавлять методы через поле `methods`, как `hooks`; коллизия со встроенным именем — ошибка при старте. Встроенные проверки доступа и лог изменений применяются только к стандартным CRUD — именованный метод, пишущий в базу напрямую, сам отвечает за права и аудит.
- `@db-state/server-mongo`: `createDbStateServer({ methodsDir, methodsContext })` — методы-файлы: `"zad.get-num"` соответствует `<папка>/zad/get-num.js` (export default = обработчик). Файл читается лениво при первом вызове и перечитывается при изменении mtime — правки применяются без перезапуска; сегменты имени валидируются, так что имя от клиента не может выйти за пределы папки; встроенные методы и `methods` имеют приоритет. Каждый файловый метод по умолчанию получает `db` и `api`; `methodsContext` добавляет своё поверх и может их переопределить. `handleRpc` принимает необязательный резолвер четвёртым аргументом.

## 0.0.11

- Vue `login()` теперь сбрасывает уже отданные reactive-документы на месте, а не удаляет их из registry таблицы: `load()` до ручной авторизации сохраняет identity объекта, очищает stale cached поля и после авторизации повторяет `load` RPC.
- Добавлена поддержка prefix для служебных коллекций: `createDbStateServer({ servicePrefix: "cfg" })` / `prefix` переводит служебные коллекции в `cfg_user`, `cfg_group`, `cfg_permission` и `cfg_log`; явные `userTable`, `groupTable`, `permissionTable` и `logCollection` по-прежнему имеют приоритет.
- Служебные таблицы теперь открываются через CRUD/RPC только если явно перечислены в `tables`; auth/permissions сервера по-прежнему используют настроенные служебные коллекции внутренне.
- `@db-state/server-files` и `@db-state/vue-files` принимают тот же prefix для default metadata-таблицы файлов (`cfg_file`), а файловые модули в `createDbStateServer({ prefix, files })` наследуют prefix сервера, если не задан явный `table`.
- Документация описывает prefixed Mongo indices и существующий env-паттерн для WebSocket port/path.

## 0.0.10

- Vue `login()` теперь начинает с чистого клиентского состояния: очищает локальный кэш документов/query и in-memory таблицы, переносит `time1` на текущий момент логина и не запускает `syncNow()`.
- Hash-auth / reconnect остается sync-путем восстановления: `authByHash()` запускает sync от сохраненного cursor и после авторизации перезапрашивает реактивные чтения, которые не загрузились из кэша.
- `syncNow()` теперь сначала применяет весь batch изменений, собирает уникальные измененные таблицы и обновляет `countRef` / `idsRef` один раз на измененную таблицу, а не один раз на каждое изменение.
- Серверные записи без авторизованного пользователя теперь используют `systemUserId` (по умолчанию `"system"`) для `info.makeid`, `info.editid` и `change.userId`, вместо пустого actor.
- Серверные RPC-ответы теперь могут содержать `meta.accessFiltered` / `meta.fieldsFiltered` / `meta.denied`, если права чтения скрыли строки, sync-изменения или отдельные свойства, при этом форма `result` не меняется.
- Vue socket RPC по-прежнему возвращает `result`, но теперь также отдает envelope `dbstate:rpc_result` / `dbstate:rpc_error` через `state.socket.on(...)` для диагностики.
- Документация теперь разделяет поток логина и поток восстановления авторизации, а также описывает batch-refresh query-ref'ов.
- Добавлены regression-тесты для очистки кэша/no-sync поведения при логине и batch-refresh query-ref'ов по измененным таблицам.

## 0.0.9

- Добавлены optional пакеты `@db-state/server-files` и `@db-state/vue-files` для upload/download файлов через тот же db-state WebSocket.
- В server socket добавлены extension points для raw binary frames и async cleanup при закрытии клиента.
- `createDbStateServer({ files })` умеет монтировать файловые модули, автоматически добавлять их служебные таблицы и объединять их access/hooks с конфигом сервера.
- Metadata файла хранится в таблице `file`; скачивание бинаря проверяется через `token + downloadPolicy` (`public`, `registered`, `verified`, `groups`), а `storageKey` никогда не отдается клиенту.
- `createFileClient(state)` регистрирует `state.file`, поддерживает progress callbacks для upload/download и позволяет файловым операциям участвовать в `state.getKeyRef(key)`.

## 0.0.8

- Vue mutation methods `add`, `update` и `remove` теперь принимают optional loading `key`, чтобы записи участвовали в счетчиках `state.getKeyRef(key)` для страницы/блока.
- `state.getKeyRef(key)` теперь возвращает реактивный объект загрузки с `value`, `max`, `start`, `percent` и совместимым `ready`.
- Документация теперь отдельно показывает, что `getKeyRef(key)` подходит и для процента загрузки страницы, и для процента внесения изменений.
- Документация теперь подчеркивает, что повторные `load(id, key)` для разных путей документа используют один reactive object, одну загрузку, патчи с сервера на месте и один progress key страницы/формы.

## 0.0.7

- Серверные code access rules упрощены до `access[table].read/write` и глобальных `access.read/write`; вложенный формат `access.table` / `access.doc` убран из документации и runtime lookup.
- Добавлен regression-тест для прямых табличных и глобальных code access rules.
- Добавлены серверные lifecycle hooks: `beforeRead`, `afterRead`, `errorRead`, `beforeWrite`, `afterWrite` и `errorWrite`, глобально и на уровне таблицы.

## 0.0.6

- Серверные `add` и `update` теперь удаляют клиентские поля `info` / `info.*` до проверки прав и сохранения.
- Серверный `add` записывает `info.makeid` и `info.makedata`; серверный `update` записывает `info.editid` и `info.editdata` из авторизованного пользователя и времени сервера.
- Добавлены regression-тесты для серверных create/edit metadata.
- Vue-клиент теперь поддерживает `state.onChange`, табличный `onChange` и фильтрованные `onAdd` / `onEdit` / `onDelete` хуки после применения локальных изменений.

## 0.0.5

- Серверная auth-логика умеет нормализовать login-идентификаторы по полю через `normalizeAuthLogin`, например lowercase email и канонический телефон.
- Неоднозначные normalized login-совпадения отклоняются той же generic auth-ошибкой и отдают warning через `onAuthWarning({ type: "ambiguous_auth_login", ... })`.
- Добавлен `authRateLimit` hook для login и hash-auth попыток.
- `@db-state/server-mongo` экспортирует `defaultPassword`, `defaultAuthHash`, `hashValue`, `createAuth`, `createHandlers`, `handleRpc` и `createSocketHub` из корня пакета.

## 0.0.4

- Серверные сигналы изменений теперь идут через debounce/rate-limit настройки `changesBroadcastDelay` и `changesBroadcastRate`, сигнал получает каждый клиент включая автора.
- Клиентский polling выключен по умолчанию (`safetySyncInterval: 0`); sync запускается после авторизации и по сигналам сервера.
- Серверная socket-рассылка умеет rate-limit и отмену активной волны, если пришло новое изменение базы.
- Документация теперь описывает signal-only sync и масштабируемую модель wake-up сигналов.

## 0.0.3

- Защищенные серверные RPC теперь ждут `state.auth.status === "authorized"`; cache-first реактивные чтения перезапрашивают только то, что не загрузилось.
- `sync update` больше не создает частичные локальные документы; `insert` по-прежнему создает документ из полного объекта в log.
- Записи ждут авторизацию до `writeAuthTimeout`, затем возвращают ошибку, если авторизация не восстановилась.
- `load()` теперь показывает `__cacheChecked` и держит `__loaded = false`, пока данные реально не пришли из кэша или сервера.
- Одноразовые чтения (`getAsync`, `getIds`, `getUnique`) теперь ждут авторизацию вместо ошибки до reconnect/auth restore.
- `@db-state/core` теперь содержит полную карту `dbstate:*` сообщений и общие TypeScript-типы служебных таблиц, прав, query и update.
- Обновлены README клиента, API-документация, auth-документация и reactive query docs под новый порядок загрузки/auth.

## 0.0.2

- Добавлена полная поддержка `skip` для `getIds`, `idsRef` и `listRef`.
- Дедупликация query теперь учитывает `skip` как часть стабильного ключа запроса.
- Добавлены тесты для пагинации `getIds` и дедупликации `idsRef` с `skip`.
- Расширена английская документация:
  - архитектура;
  - sync protocol;
  - модель change log;
  - cookbook админки;
  - cookbook audit trail;
  - cookbook offline PWA;
  - advanced patterns.
- README обновлены так, чтобы сразу объяснять реактивные документы из БД, реактивные списки, реактивные счетчики, sync, права и офлайн-чтение.

## 0.0.1

Первый публичный релиз:

- `@db-state/core`: общий протокол, форма change, dot-path helpers.
- `@db-state/vue`: Vue 3 клиент с реактивными документами, `listRef`, `idsRef`, `countRef`, auth, sync и IndexedDB cache.
- `@db-state/server-mongo`: MongoDB WebSocket сервер с CRUD, append-only log, sync, auth и permissions.

## Текущий статус

- Workspace версии `0.1.0` содержит пять пакетов и покрыт 103 тестами.
- Реализованы realtime CRUD с групповой access-моделью, offline cache, login, sync, custom methods и optional file transfer.
- TypeScript declarations есть во всех пакетах.
- Append-only log поддерживает audit trail, восстановление удалений и time-travel reconstruction patterns.
- Поддерживаемый стек: Vue + MongoDB + WebSocket.

## Текущие ограничения

- Переносимый контракт декларативных фильтров `access` — equality-style matching с dot-path полями и подстановками `"$adminid"` / `"$groupid"`. Для динамических, внешних и междокументных условий используй хук `beforeRead`.
- Мультидокументные записи пока не атомарны. Для сценариев, где нужно менять несколько таблиц вместе, используй application/server-side код; `batch()`/transaction API планируется.
- Именованные и файловые методы являются first-class RPC, но прямые записи в базу внутри них автоматически не проходят встроенные проверки доступа и не добавляются в db-state change log.
- File transfer v1 не умеет resumable upload после reconnect; прерванный upload получает `failed`, а временный файл удаляется.
- Встроенный file storage adapter - local filesystem. Для S3-compatible/object storage нужен custom `FileStorage` adapter.
- File module сейчас разрешает один active upload и один active download на socket, чтобы backpressure оставался простым.
- Wake-up сигналы изменений уже идут через debounce/rate-limit, но для больших инсталляций может понадобиться per-table/per-client filtering или custom broadcast layer.
- Sync обрабатывает все строки в окнах не более 12 часов. Cursor старше 20 дней запускает очистку клиентского cache и перечитывание текущего состояния.
- Offline writes намеренно не ставятся в очередь. Клиент поддерживает offline read, а записи требуют онлайн-сокет.
- React, Postgres, SQLite и другие адаптеры не входят в текущий пакет.
