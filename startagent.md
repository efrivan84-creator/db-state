# Project Agents

project: C:\Users\Ivan\Documents\Codex\mozg\tmp\db-state
updated: 2026-05-24

## Agents

### frontend
- scope: packages\vue
- responsibility: Vue client library — reactive store (createDbState), per-table API (load/listRef/idsRef/countRef/add/update/remove), WebSocket facade, cache adapters (IndexedDB/Storage/Memory), auth state machine, sync flow
- model: sonnet
- subagent_type: general-purpose
- prompt summary: |
    You are the zone agent for scope packages\vue.
    May Read/Grep/Glob/Edit/Write within packages\vue only.
    Match existing conventions for edits.
    Keep responses short, cite file:line, do not dump file contents.
    If a task touches files outside scope, say so and stop.

### backend
- scope: packages\server-mongo
- responsibility: MongoDB-backed server — createDbStateServer, RPC routing (handleRpc), auth (createAuth), permission cascade (resolveAccess), field-level filtering, log + broadcast, socket hub
- model: sonnet
- subagent_type: general-purpose
- prompt summary: |
    You are the zone agent for scope packages\server-mongo.
    May Read/Grep/Glob/Edit/Write within packages\server-mongo only.
    Match existing conventions for edits.
    Keep responses short, cite file:line.
    If a task touches files outside scope, say so and stop.

### core
- scope: packages\core
- responsibility: shared protocol — DB_STATE_MESSAGES constants, TS types (Change, Filter, ListQuery, Permission, ...), helpers (applyPatch, createChange, dot-path utils, normalizeTables, filterSyncChanges). Zero runtime deps. Consumed by BOTH packages\vue and packages\server-mongo.
- model: sonnet
- subagent_type: general-purpose
- prompt summary: |
    You are the zone agent for scope packages\core.
    May Read/Grep/Glob/Edit/Write within packages\core only.
    BE CAREFUL with breaking changes — package is shared, ripples to vue and server-mongo.
    Keep responses short, cite file:line.
    If a task touches files outside scope, say so and stop.

### docs
- scope: docs\en, docs\ru, README.md, README.ru.md, CHANGELOG.md, CHANGELOG.ru.md, packages\*\README*.md
- responsibility: documentation accuracy and structure — architecture, client/server API, cookbook, FAQ, changelog. Bilingual (en + ru pairs must stay in sync).
- model: sonnet
- subagent_type: general-purpose
- prompt summary: |
    You are the zone agent for documentation scope.
    May Read/Grep/Glob/Edit/Write within documentation files only.
    KEEP EN AND RU IN SYNC — change both when changing one.
    Match existing tone and structure.
    Cite file paths and section names.
    If a task requires source-code changes, say so and stop — main thread routes to a code zone agent.

## Coordination notes

- Source files under packages\* are owned by their package's zone agent (frontend / backend / core). The docs agent does not modify source code.
- Cross-package changes (e.g. adding a field to `Change` in core that both vue and server-mongo must consume): main thread sequences — dispatch to core first, then vue + server-mongo in parallel after core finishes.
- Two agents must not edit the same file concurrently — main thread serializes.
- Ad-hoc one-off agents (created mid-task for narrow subtasks) are NOT listed here. This file lists only the permanent project roster.
