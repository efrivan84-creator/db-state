import { createDbState, createMemoryCache } from "../../../packages/vue/src/index.js"

export const state = createDbState({
  tables: ["order"],
  cache: createMemoryCache(),
  wsUrl: "ws://127.0.0.1:8787/db-state/ws"
})
