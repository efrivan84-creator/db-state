import { createApp } from "vue"

import App from "./App.vue"
import "./style.css"

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/db-state-offline-sw.js").catch(console.error)
  })
}

createApp(App).mount("#app")
