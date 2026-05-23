# FAQ

## General

### Why another state library?

Because nothing in the Vue ecosystem combines reactive collections + realtime sync + permissions + offline cache in under 100 KB. Apollo is 33 KB just for queries. RxDB needs schemas + replication setup. Convex/Firestore are vendor services. Pinia + manual WebSocket is what most people end up writing, and that's hundreds of lines of boilerplate per project.

db-state is the boilerplate, extracted into a library that fits in ~4 KB brotli on the client.

### Is it production-ready?

`0.0.x`. The shape of the API is stable and 50 tests cover the core behavior, but you should expect minor breaking changes until `1.0`. Audit trail and time-travel work by design; the lack of optimistic concurrency control is intentional (see [next question](#what-about-conflicts-between-concurrent-edits)).

### What about conflicts between concurrent edits?

The library does **not** version documents or block concurrent writes. Instead it relies on:

1. **Append-only log** — every change is recorded with `userId`, `set`/`unset`, and the `old` snapshot for deletes. Even if two users overwrite the same field, both writes are in the log forever and either can be replayed.
2. **Diff-based saves on the client** — see the [admin panel cookbook](cookbook/admin-panel.md). Two users editing different fields of the same document do not conflict; their patches merge naturally.
3. **Live merge on the form** — your form re-reads the document from the reactive store as changes arrive, so you usually see the conflict before saving.

This is closer to event-sourcing than to optimistic locking. It's a deliberate trade-off, not a missing feature.

### Why Vue and Mongo only?

Because every layer of "universal" — extra adapters, abstraction over query languages, plugin systems — costs bytes and complexity. The library is small precisely because it doesn't try to support React + Postgres + SQLite + Solid + Svelte. Each combination would double the maintenance surface.

If you need React or Postgres, look at [Convex](https://convex.dev), [RxDB](https://rxdb.info), or [Replicache](https://replicache.dev).

### What's the bundle size really?

| Build | Size |
|---|---|
| Raw ESM source | 28.7 KB |
| Minified (terser) | 17.2 KB |
| Minified + gzip | 5.4 KB |
| Tree-shaken (esbuild) + gzip | 4.6 KB |
| Tree-shaken + brotli | **4.2 KB** |

Brotli is what modern CDNs serve over HTTPS. Without tree-shaking (unusual today), you ship ~5.4 KB instead of ~4.2 KB.

## Client

### Does `listRef` automatically unsubscribe when the component unmounts?

You don't need to do anything — refs are tracked through Vue's normal reactivity. The internal data is shared globally (it's a singleton store), so unmounting a component doesn't tear down anything. The next time another component asks for the same `listRef(query)`, it gets the existing ref instantly (no extra server roundtrip).

If you need to release a query entirely, call `state.clearLocalDB()` (full reset) or pass a different `key` to track loading separately.

### Do I need to pass a `key` to `load(id, key)`?

No, it's optional. The `key` is used only to track combined loading state for a group of related loads — e.g. all docs needed by one page. Read [client/reactive-queries.md](client/reactive-queries.md#loading-keys) for the pattern.

### Can I use it without TypeScript?

Yes. Every example in this doc has a plain-JS equivalent. TypeScript adds compile-time safety on filters, sort keys and update fields, but the runtime is identical.

### Where is the entity cache stored?

By default: **IndexedDB**. Falls back to in-memory if IndexedDB is unavailable (SSR, Node tests). You can switch backends:

```js
import { createStorageCache, createMemoryCache } from "@db-state/vue"

createDbState({
  tables: ["order"],
  cache: createStorageCache({ key: "myapp.cache" })  // localStorage
})
```

See [client/cache-and-offline.md](client/cache-and-offline.md).

### How do I clear a stale cache after a schema change?

```js
await state.clearLocalDB()
```

This wipes IndexedDB records, `time1`, the session id and the in-memory reactive tables. Auth is not touched.

For deployments, you can also bump a "cache version" prefix in `cache` options so old caches are ignored after a release.

## Server

### Are permissions checked on the server, or just the client?

**Server only**. The client has no permission knowledge — it just calls RPCs. Every RPC method (`load`, `update`, `add`, `remove`, `sync`, `count`, `getIds`, `getUnique`) runs `assertAccess` before touching Mongo.

A malicious client cannot bypass permissions by editing JavaScript. Field-level rules are enforced both on read (server projects the result) and on write (server validates `set`/`unset` paths against `write.fields`).

### How are passwords stored?

The default adapter uses PBKDF2-SHA256 with 120k rounds and 16-byte salt — comparable to bcrypt at default cost. You can replace it with bcrypt/argon2 by passing a custom `password: { hash, verify }` to `createDbStateServer`. See [server/authentication.md](server/authentication.md#password-adapters).

### Can a user be logged in on multiple devices?

Yes. The user's `hash` (server-side auth token) is reused across devices — second device logging in gets the same hash. Opening a new tab doesn't invalidate existing sessions. To force-logout everywhere, rotate the user's `_user.hash` value on the server.

### What happens if I have 1000 connected clients?

Writes append to the log immediately, then `changes_available` is broadcast after a debounce delay and at a configured client rate. Each client pulls the diff via `sync`. This degrades predictably: more online clients means slower wake-up waves, not unbounded instant fan-out.

If you're hitting this today, look at [advanced patterns](cookbook/advanced-patterns.md#scaling-broadcasts).

### How big can the log get?

One row per change forever, with full `old` snapshot on deletes. For a typical CRUD app this is a few KB per change. Set `{ createdAt: 1, logId: 1 }` index (the demo seed does it) and reads stay fast for millions of entries.

If retention matters, you can periodically prune `log` entries older than N days that are also outside any current client's `time1` window. The library doesn't prune automatically — that's a policy decision.

## Roadmap & contributions

### Will you add operator support to `if` conditions?

Yes, this is the next planned change. The current `matchesIf` only does equality (`{ status: "open" }`). The intended extension supports `$in`, `$ne`, `$gt`, `$lte`, `$eq` and dot-path access to `ctx.user` (`{ ownerId: { $eq: "user._id" } }`).

For now, any non-trivial predicate goes through code rules. See [server/code-access-rules.md](server/code-access-rules.md).

### Will you add React support?

Not from upstream. The core library is framework-agnostic — building `@db-state/react` is a clean lift, mostly replacing Vue's `reactive`/`ref`/`computed` with React's `useSyncExternalStore`. Community PRs welcome.

### How do I propose changes?

Open an issue first on [GitHub](https://github.com/efrivan84-creator/db-state/issues) describing the use case. For docs gaps, just file the issue — those are usually a quick fix.
