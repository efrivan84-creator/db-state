export async function runHooks(config, table, name, ctx) {
  for (const hook of getHooks(config.hooks, table, name)) {
    await hook(ctx)
  }
}

export async function runErrorHooks(config, table, name, ctx) {
  for (const hook of getHooks(config.hooks, table, name)) {
    try {
      await hook(ctx)
    } catch {
      // Keep the original operation error authoritative.
    }
  }
}

function getHooks(hooks, table, name) {
  return [
    hooks?.[name],
    table ? hooks?.[table]?.[name] : undefined
  ].filter(Boolean)
}
