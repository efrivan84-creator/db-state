import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:net"
import test from "node:test"
import { fileURLToPath } from "node:url"

// demo/smoke.js — сквозная проверка через настоящий WebSocket: вход, права
// групп и слияние полномочий, хуки файлами, readChange при sync, RPC-методы.
// Входит в npm test, чтобы demo не расходилось с библиотекой: раньше его
// запускали отдельной командой, и о поломке узнавали последними.
//
// demo2 здесь нет: ему нужна настоящая MongoDB (npm run demo2:smoke).

test("demo smoke: the in-memory demo passes end to end over WebSocket", { timeout: 60_000 }, async () => {
  const port = await freePort()
  const smoke = spawn(process.execPath, [fileURLToPath(new URL("../demo/smoke.js", import.meta.url))], {
    env: { ...process.env, DB_STATE_DEMO_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  })

  let output = ""
  smoke.stdout.on("data", (chunk) => { output += chunk })
  smoke.stderr.on("data", (chunk) => { output += chunk })
  const code = await new Promise((resolve) => smoke.on("close", resolve))

  assert.equal(code, 0, output)
  assert.match(output, /demo smoke ok/)
})

// Свободный порт: слушаем 0, берём выданный, отпускаем.
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}
