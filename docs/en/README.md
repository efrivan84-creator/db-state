# db-state Documentation

> **English** · [Русский](../ru/README.md)

Full documentation for the [db-state](https://github.com/efrivan84-creator/db-state) library — a tiny realtime reactive state layer for Vue 3 + MongoDB.

## Start here

- [Getting started](getting-started.md) — install, run the demo, and see the library work in 5 minutes.
- [FAQ](faq.md) — quick answers to the most common questions.

## Client (Vue 3)

How to use `@db-state/vue` in a Vue 3 app.

- [Reactive queries](client/reactive-queries.md) — `load`, `listRef`, `idsRef`, `countRef`, `getAsync` and how they update live.
- [Mutations](client/mutations.md) — `add`, `update`, `remove` and what happens on the server.
- [Authentication](client/authentication.md) — `login`, `authByHash`, auto-auth, logout, multi-tab behavior.
- [Cache and offline](client/cache-and-offline.md) — IndexedDB, localStorage and memory cache backends; offline read patterns.
- [TypeScript](client/typescript.md) — schema generics, typed filters/sort/update, custom service tables.
- [Socket (custom events)](client/socket.md) — share the WebSocket with app-level events.
- [Client API reference](client/api-reference.md) — every export, every option, every method.

## Server (Node + MongoDB)

How to set up `@db-state/server-mongo`.

- [Setup](server/setup.md) — minimal server, ws integration, configuration.
- [Permissions](server/permissions.md) — the `_permission` table, `if`-conditions, field projections, common patterns.
- [Code access rules](server/code-access-rules.md) — JS callback rules at the table or document level.
- [Authentication](server/authentication.md) — user table, password adapters, hash auth, custom password hashers.
- [WebSocket integration](server/websocket-integration.md) — `ws`, `uWebSockets.js`, Fastify, custom adapters.
- [Server API reference](server/api-reference.md) — every CRUD method, every option, every type.

## Architecture

How db-state works under the hood — read these to debug confidently and to extend the library.

- [How it works](architecture/how-it-works.md) — high-level data flow, the role of each package.
- [Sync protocol](architecture/sync-protocol.md) — `time1`, log windows, session-based echo filtering, broadcast `changes_available`.
- [Change log](architecture/change-log.md) — append-only log format, audit trail, time-travel rollback, retention.

## Cookbook

End-to-end recipes for common production patterns.

- [Admin panel](cookbook/admin-panel.md) — typed multi-table CRUD with field-level permissions.
- [Audit trail](cookbook/audit-trail.md) — "who changed what when" with the existing log.
- [Offline PWA](cookbook/offline-pwa.md) — service worker + cached reads.
- [Advanced patterns](cookbook/advanced-patterns.md) — diff-based saves, soft delete, multi-tenant, rate-limited refresh, custom cache backend.

---

Couldn't find what you needed? Open an [issue](https://github.com/efrivan84-creator/db-state/issues) — docs gaps count as bugs.
