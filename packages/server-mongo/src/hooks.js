// Хуки объявляются глобально, по одному на имя. Таблица разбирается
// внутри самого хука через ctx.table.
//
// Возврат before-хука решает судьбу запроса:
//   false / { allowed: false, reason } — запрет, цепочка прерывается;
//   true / { allowed: true }           — разрешено, access группы не проверяется;
//   undefined / null                   — решения нет, проверяется access группы.
// Изменения ctx применяются в любом случае, независимо от возврата.

export async function runHooks(config, name, ctx) {
  const hook = config.hooks?.[name]
  if (!hook) return undefined

  return normalizeHookDecision(await hook(ctx))
}

export async function runErrorHooks(config, name, ctx) {
  const hook = config.hooks?.[name]
  if (!hook) return

  try {
    await hook(ctx)
  } catch {
    // Ошибка исходной операции остаётся главной.
  }
}

function normalizeHookDecision(decision) {
  if (decision === undefined || decision === null) return undefined
  if (typeof decision === "boolean") return { allowed: decision }
  if (typeof decision !== "object") return { allowed: Boolean(decision) }
  if (!("allowed" in decision)) return undefined

  return { allowed: Boolean(decision.allowed), reason: decision.reason }
}
