# Документация db-state

> [English](../en/README.md) · **Русский**

Полная документация по [db-state](https://github.com/efrivan84-creator/db-state): маленькому realtime-слою состояния для Vue 3 + MongoDB.

## Начать отсюда

- [Быстрый старт](getting-started.md) - установка, минимальный сервер и клиент.
- [Что клиент может запросить у сервера](protocol-requests.md) - одной таблицей: все системные сообщения, RPC-методы, файлы и сигналы сервера.
- [Карта прохода запроса](request-flow.md) - порядок `beforeRead` → права группы → `afterRead`, где стоит точка записи в базу.
- [Область применения](scope-and-use-cases.md) - где db-state подходит, а где лучше выбрать другой инструмент.
- [FAQ](faq.md) - короткие ответы на частые вопросы.

## Файлы

- [Файлы](files.md) - `@db-state/server-files`, `@db-state/vue-files`, upload/download, политики скачивания и storage adapters.

## Клиент (Vue 3)

- [Реактивные запросы](client/reactive-queries.md) - `load`, `listRef`, `idsRef`, `countRef`, `getAsync`.
- [Мутации](client/mutations.md) - `add`, `update`, `remove` и локальные эффекты.
- [Аутентификация](client/authentication.md) - `login`, `authByHash`, auto-auth, logout.
- [Кэш и офлайн](client/cache-and-offline.md) - IndexedDB, Web Storage, memory cache, offline read.
- [TypeScript](client/typescript.md) - schema generic, типизированные фильтры, sort и update.
- [Socket и custom events](client/socket.md) - как использовать тот же WebSocket для событий приложения.
- [Client API reference](client/api-reference.md) - все методы и типы клиента.

## Сервер (Node + MongoDB)

- [Настройка сервера](server/setup.md) - минимальный сервер, индексы, WebSocket.
- [Права доступа](server/permissions.md) - объект `access` на группах, фильтры строк, `read_fields`/`write_fields`.
- [Хуки сервера](server/hooks.md) - `beforeRead`/`beforeWrite` и другие: правка запроса, поля, разрешение и запрет.
- [Аутентификация сервера](server/authentication.md) - `_user`, password adapters, hash auth.
- [WebSocket integration](server/websocket-integration.md) - `ws`, `uWebSockets.js`, Fastify, custom adapters.
- [Server API reference](server/api-reference.md) - CRUD, sync, hooks, socket hub, config.

## Архитектура

- [Как это работает](architecture/how-it-works.md) - общий поток данных и роли пакетов.
- [Sync protocol](architecture/sync-protocol.md) - `time1`, log windows, echo suppression, `changes_available`.
- [Change log](architecture/change-log.md) - append-only log, audit trail, восстановление удалений и retention.

## Cookbook

- [Админ-панель](cookbook/admin-panel.md) - CRUD UI, таблицы, карточка записи, diff-based save.
- [Audit trail](cookbook/audit-trail.md) - лента изменений, история документа, восстановление.
- [Offline PWA](cookbook/offline-pwa.md) - service worker и cached reads.
- [Advanced patterns](cookbook/advanced-patterns.md) - soft delete, multi-tenant, custom cache, scaling broadcasts.

Если чего-то не хватает, это ошибка документации. Заводи issue или дополняй страницу рядом с английской версией.
