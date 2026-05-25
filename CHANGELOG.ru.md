# Changelog

Описание изменений и статус проекта db-state.

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

- Realtime CRUD с правами, offline cache, login и sync реализован и покрыт 65 тестами.
- TypeScript declarations есть во всех пакетах.
- Append-only log поддерживает audit trail, восстановление удалений и time-travel reconstruction patterns.
- Поддерживаемый стек: Vue + MongoDB + WebSocket.

## Текущие ограничения

- `_permission.if` сейчас поддерживает equality-style matching. Операторы вроде `$in`, `$ne`, `$gte` и dot-path сравнения с user планируются.
- Фильтрация прав для list/count запросов сейчас выполняется после чтения подходящих документов из Mongo. Для больших таблиц пока добавляй узкие app-level фильтры; server-side access prefilter hook планируется.
- Мультидокументные записи пока не атомарны. Для сценариев, где нужно менять несколько таблиц вместе, используй application/server-side код; `batch()`/transaction API планируется.
- Доменные server actions пока не являются отдельным first-class слоем. Custom socket events уже есть, но request/response action layer планируется для операций вроде отправки сообщения в чат.
- Binary upload/chunk helpers пока не входят в пакет. Для больших медиа используй отдельный upload path или custom WebSocket protocol.
- Wake-up сигналы изменений уже идут через debounce/rate-limit, но для больших инсталляций может понадобиться per-table/per-client filtering или custom broadcast layer.
- `syncLimit` должен вмещать одно sync-окно. Для очень большого числа записей нужен cursor continuation по `{ createdAt, logId }`.
- Offline writes намеренно не ставятся в очередь. Клиент поддерживает offline read, а записи требуют онлайн-сокет.
- React, Postgres, SQLite и другие адаптеры не входят в текущий пакет.
