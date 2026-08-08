import { loadHooksDir } from "./hooks-dir.js"

// Хуки приложения объявляются только файлами в hooksDir — см. hooks-dir.js.
//
// Отдельный слой — хуки подключённых модулей (например server-files). Это
// внутреннее устройство модуля, а не конфигурация приложения: модуль так
// защищает свою таблицу и пропускает собственные внутренние вызовы. Они
// выполняются до файловых и в hooksDir не переносятся.
//
// Возврат before-хука решает судьбу запроса:
//   false / { allowed: false, reason } — запрет, цепочка прерывается;
//   true / { allowed: true }           — разрешено, access группы не проверяется;
//   undefined / null                   — решения нет, проверяется access группы.
// Изменения ctx применяются в любом случае, независимо от возврата.

export async function runHooks(config, name, ctx) {
  for (const hook of await resolveHooks(config, name)) {
    const decision = normalizeHookDecision(await hook(ctx))
    // Первое явное решение останавливает цепочку.
    if (decision !== undefined) return decision
  }

  return undefined
}

export async function runErrorHooks(config, name, ctx) {
  for (const hook of await resolveHooks(config, name)) {
    try {
      await hook(ctx)
    } catch {
      // Ошибка исходной операции остаётся главной.
    }
  }
}

// Сначала хуки модулей, затем файловый хук приложения.
//
// hooksDir сканируется один раз при первом обращении: createDbStateServer
// синхронный, а чтение папки — нет. Промис запоминается, поэтому
// параллельные запросы на старте не запустят скан дважды.
async function resolveHooks(config, name) {
  const chain = config.moduleHooks?.[name] ?? []
  if (!config.hooksDir) return chain

  config.__hooksDirPromise ??= loadHooksDir(config.hooksDir, config.reloadCheckMs)
  const fileHook = (await config.__hooksDirPromise)[name]
  return fileHook ? [...chain, fileHook] : chain
}

function normalizeHookDecision(decision) {
  if (decision === undefined || decision === null) return undefined
  if (typeof decision === "boolean") return { allowed: decision }
  if (typeof decision !== "object") return { allowed: Boolean(decision) }
  if (!("allowed" in decision)) return undefined

  return { allowed: Boolean(decision.allowed), reason: decision.reason }
}
