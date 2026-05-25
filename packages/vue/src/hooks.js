export function createChangeHooks(tables) {
  return {
    global: new Set(),
    tables: new Map(tables.map((table) => [table, new Set()]))
  }
}

export function subscribe(hooks, callback) {
  hooks.add(callback)
  return () => hooks.delete(callback)
}

export function subscribeAction(hooks, action, callback) {
  return subscribe(hooks, (event) => {
    if (event.change.action !== action) return

    if (action === "delete") {
      callback(event.oldObj, event.change)
    } else {
      callback(event.obj, event.change)
    }
  })
}

export function notifyChangeHooks(hooks, options, change, obj, oldObj) {
  const tableHooks = hooks.tables.get(change.table)
  const event = { change, obj, oldObj }

  callHooks(hooks.global, options, change)
  callHooks(tableHooks, options, event)
}

function callHooks(hooks, options, ...args) {
  for (const callback of hooks ?? []) {
    try {
      callback(...args)
    } catch (error) {
      options.onError(error)
    }
  }
}
