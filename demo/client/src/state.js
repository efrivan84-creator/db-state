import { createDbState, createMemoryCache } from "@db-state/vue"

export const state = createDbState({
  tables: ["order"],
  cache: createMemoryCache(),
  wsUrl: "ws://127.0.0.1:8787/db-state/ws"
})
