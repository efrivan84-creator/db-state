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
  const hooks = await resolveHooks(config, name)
  if (hooks.length === 0) return undefined

  applyHookContext(config, ctx)

  for (const hook of hooks) {
    const decision = normalizeHookDecision(await hook(ctx))
    // Первое явное решение останавливает цепочку.
    if (decision !== undefined) return decision
  }

  return undefined
}

export async function runErrorHooks(config, name, ctx) {
  const hooks = await resolveHooks(config, name)
  if (hooks.length === 0) return

  applyHookContext(config, ctx)

  for (const hook of hooks) {
    try {
      await hook(ctx)
    } catch {
      // Ошибка исходной операции остаётся главной.
    }
  }
}

// db, api и всё из methodsContext — в ctx: хук может не только решать судьбу
// запроса, но и сам читать и писать — поднять флаг в соседней таблице,
// дописать связанный документ.
//
// db — драйвер Mongo как есть, мимо прав и журнала изменений.
// api — те же команды, что у клиента: с проверкой прав, журналом и рассылкой.
// Остальное кладёт приложение через methodsContext — то же, что получают
// файловые методы: вторая база, транзакция, внешний клиент.
//
// Присваиваем централизованно перед вызовом, а не в каждом месте создания
// ctx. api собирается последним, но записывается в общий контекст до возврата
// createDbStateServer, поэтому уже первый хук получает готовый объект.
//
// ??= а не присваивание: значение, уже положенное в ctx самим сервером или
// хуком модуля, важнее общего. Поля самого запроса (table, id, set) в
// hookContext не попадают, перекрыть их приложение не может.
function applyHookContext(config, ctx) {
  const context = config.hookContext
  if (!context) return

  for (const [key, value] of Object.entries(context)) {
    ctx[key] ??= value
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
