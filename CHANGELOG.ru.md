# Changelog

Описание изменений и статус проекта db-state.

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

- Realtime CRUD с правами, offline cache, login и sync реализован и покрыт 40 тестами.
- TypeScript declarations есть во всех пакетах.
- Append-only log поддерживает audit trail, восстановление удалений и time-travel reconstruction patterns.
- Поддерживаемый стек: Vue + MongoDB + WebSocket.

## Текущие ограничения

- `_permission.if` сейчас поддерживает equality-style matching. Операторы вроде `$in`, `$ne`, `$gte` и dot-path сравнения с user планируются.
- Broadcast сейчас будит всех подключённых клиентов при каждой записи. Для больших инсталляций нужен per-table/per-client filtering или custom broadcast layer.
- `syncLimit` должен вмещать одно sync-окно. Для очень большого числа записей нужен cursor continuation по `{ createdAt, logId }`.
- Offline writes намеренно не ставятся в очередь. Клиент поддерживает offline read, а записи требуют онлайн-сокет.
- React, Postgres, SQLite и другие адаптеры не входят в текущий пакет.
