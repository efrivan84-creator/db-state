# Scope and use cases

> **English** · [Русский](../ru/scope-and-use-cases.md)

This page answers a question that comes up before anyone tries the library: **«Is db-state the right tool for *my* project?»**

The short answer: **db-state covers 70-90% of the realtime state in almost any project — including ones where you also need ultra-low-latency channels (games, voice, live cursors)**. The library is designed to be the **foundation layer**; speed-critical features are added as a thin custom layer over the same socket.

This page explains that layering model, shows where db-state fits in different kinds of projects, and is honest about where the line stops.

## The layering model

Almost any non-trivial realtime product has state with **different latency requirements**:

```
┌─────────────────────────────────────┐
│ Ultra-low-latency layer             │  ← custom code, ~50-500 lines per project
│  - positions, hits, voice, cursors  │
├─────────────────────────────────────┤
│ State / sync layer (db-state)       │  ← @db-state/vue: 5.4 KB brotli
│  - profiles, inventory, scores      │
│  - chat, matchmaking, lobby         │
│  - settings, achievements, history  │
├─────────────────────────────────────┤
│ Persistence (MongoDB)               │
└─────────────────────────────────────┘
```

db-state handles the layer in the middle — persistent, authoritative, permission-checked, reactive state that needs to be synced across many clients but doesn't need sub-50ms latency.

Above that, you write a thin custom protocol — over the **same WebSocket** the library already uses — for things that need to be instant.

## Why this works specifically with db-state

Most realtime libraries don't make this layering easy:

| Alternative | Why layering custom on top is hard |
|---|---|
| Firebase / Firestore | Closed protocol; you'd open a second WebSocket for your custom layer, with its own auth. |
| Convex / InstantDB | Managed service, no raw socket access. |
| Hasura / Supabase | GraphQL or REST APIs; realtime is a separate Phoenix-style channel. |
| RxDB + CouchDB replication | No custom event channels — only document replication. |
| Apollo + GraphQL Subscriptions | Subscriptions go through Apollo; custom protocol requires a parallel WebSocket. |

db-state lets you do this trivially:

```js
// State (handled by db-state)
const player = state.player.load(userId)
await state.player.update({ id: userId, set: { inventory: [...] } })

// Custom ultra-fast channel (same socket, your protocol)
state.socket.on("position:update", (msg) => {
  applyOpponentPosition(msg.payload)
})

state.socket.send("position:update", {
  x, y, z, ts: performance.now()
})
```

One socket. One auth. Two protocols at two speeds.

The `dbstate:*` namespace is reserved for the library; anything else is yours. Auth is verified once; both layers see the same `userId`. There's no second connection, no second handshake, no CORS concerns.

## What db-state covers in different project types

### Admin panels / CRM / dashboards

**Custom code beyond db-state: 0 lines.**

The library does everything: typed reactive tables, CRUD, login, sync, permissions, offline cache. You write `state.order.update({...})` and the UI updates everywhere.

This is the canonical use case (see [demo2](../../demo2)).

### Collaborative editors (Notion / Linear / kanban-style)

**Custom code: ~50 lines for cursor positions and selection ranges.**

- Documents, blocks, projects, tasks → db-state handles
- Comments, mentions, history → db-state handles
- Sharing permissions → db-state's `_permission` table
- Cursor positions, "X is typing", selection highlights → custom channel via `state.socket`

The custom layer here is small because cursors are ephemeral — no need to persist every cursor move to Mongo.

### B2B applications (CRM, ERP, monitoring dashboards)

**Custom code: 0 lines** for most use cases. **~50-100 lines** if you have live metric streams that should update faster than 1 second.

Standard tables (deals, customers, tickets, alerts) sync through db-state. Live KPI tickers can update via `state.metric.update(...)` with debounce set lower for that table, or via a custom event channel.

### Browser-based multiplayer (casual games, party games, strategy)

**Custom code: ~100-200 lines for turn/move synchronization.**

- Match metadata, players, scores, chat → db-state
- Game state changes on player actions → db-state
- Turn synchronization, optimistic moves → custom channel for low-latency feedback
- Final move resolution → db-state mutation (authoritative)

20Hz position updates for 10 players work comfortably with `changesBroadcastDelay: 50ms` on the relevant table.

### Real-time auctions / bidding / live commerce

**Custom code: ~100-200 lines for the order-book / bid-tape diffs.**

- Listings, items, user balances, transaction history → db-state
- Live price tickers and bid updates → db-state with low debounce, or custom event channel
- "X just placed a bid" notifications → app-level event via `state.socket`

### Trading platforms

**Custom code: ~200-500 lines for order book streaming and chart data.**

- Account state, positions, orders, settings, history, watchlists → db-state
- Order book level diffs at 10-100ms cadence → custom channel for speed
- Chart candles → cached via db-state, streamed updates via custom channel

### MMO / casual real-time games

**Custom code: ~500-1000 lines for the movement and combat protocol.**

- Player profiles, inventory, guilds, achievements, friends, leaderboards → db-state
- Match results, post-game stats, XP, currency → db-state
- Real-time positions, actions, hits → custom binary-ish protocol over the same WebSocket
- Lobby, matchmaking, chat → db-state

### FPS / hardcore action games

**Custom code: ~2000+ lines for the full network stack.**

This is where the custom layer becomes substantial — you need client-side prediction, lag compensation, anti-cheat hooks, server-authoritative physics. None of that is db-state's job.

But the **metagame** — everything outside the actual gameplay loop — is still db-state's natural territory:

- Account, friends, party, matchmaking → db-state
- Loadout, skins, currency, battle pass → db-state
- Match history, replays metadata, stats → db-state
- Store, leaderboards, achievements → db-state
- In-lobby chat, post-game chat → db-state

In a typical FPS codebase, the metagame is 60-80% of the total backend state. db-state takes that for free; you focus on the 20% that's actually game-specific.

## Where db-state is not the right choice

There's a clear line. Some categories don't fit and shouldn't be forced:

- **CRDT-based collaborative text editing** (Google Docs, Figma-like canvas). Use [Yjs](https://yjs.dev) or [Automerge](https://automerge.org) — they solve a different problem (multi-master merge with character-level conflict resolution).
- **Voice / video streaming**. WebRTC, not WebSocket.
- **High-frequency time-series ingestion**. Specialized stores like ClickHouse / TimescaleDB; db-state isn't built for millions of writes per second.
- **React / Svelte / Solid frontends**. db-state has a Vue 3 client only. The core protocol is framework-agnostic — a port is feasible — but not shipping today.
- **PostgreSQL / SQLite backends**. db-state ships only `@db-state/server-mongo`. The protocol could be implemented over Postgres (with logical replication or triggers) but again — not today.
- **Authoritative game logic** (physics, anti-cheat, lag compensation). The library is a state-sync transport, not a game engine.

If your **entire product** is one of these categories, db-state is the wrong tool. If only **part of it** is, db-state still covers everything else.

## A practical sizing table

How much of your project's realtime state, in line-of-code terms, does db-state handle?

| Project type | db-state covers | Custom code on top | Why |
|---|---:|---:|---|
| Admin / CRM / dashboard | 100% | 0 lines | Pure CRUD with permissions |
| Collaborative editor | ~95% | ~50 lines | Just cursor positions and live highlights |
| Browser multiplayer (casual) | ~85% | ~100-200 lines | Turn/move sync needs low latency |
| Real-time auction | ~90% | ~100-200 lines | Bid tape streaming |
| Trading platform | ~80% | ~200-500 lines | Order book + charts |
| Casual MMO | ~70% | ~500-1000 lines | Movement protocol |
| FPS / action game | ~60% | ~2000+ lines | Full game network stack |

In every row, db-state handles **the majority** of the realtime state. That's why "use db-state as the foundation and write thin custom layers for speed-critical bits" is a viable architecture even for projects that look unrelated at first glance.

## Why a single socket matters

The most underrated property of this layering model is that **everything runs over one WebSocket**:

- One TCP connection to manage.
- One reconnect strategy.
- One auth — both layers see the same `userId`.
- One latency budget for the socket itself.
- One observability surface.
- One firewall rule.
- One WSS termination point.

Compare to projects that split realtime across "Firestore for state + Socket.IO for chat + WebRTC for voice + custom for game" — each is its own auth, its own reconnect, its own monitoring. The mental load grows linearly with the number of channels.

With db-state, your custom layer is a few `state.socket.on(...)` and `state.socket.send(...)` calls in the same code that already talks to the database.

## Bottom line

You can build almost any product with db-state as the foundation. The library is honest about not trying to be a game engine, a CRDT solver, or a voice transport — for those, use the right tool. But for **everything that fits the "persistent state synced across many clients with permissions and offline cache"** mold, db-state covers it.

For projects that also need ultra-low-latency channels, those layer cleanly on top — no second connection, no second auth, no protocol explosion. You write maybe 50-500 lines for the speed-critical part and let db-state handle the other 70-90% of your project's state for free.

That makes db-state a **base layer**, not a niche tool. The niche is the assumption.
