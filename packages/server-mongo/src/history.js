import { createChange } from '@db-state/core'
import { filterChangeFields, projectFields } from './access.js'
import { runHooks } from './hooks.js'

const keyOf = source => JSON.stringify([source.table, source.id])
const intersect = (a, b) => !a ? b : !b ? a : [...new Set([...a, ...b].filter(path =>
  a.some(field => path === field || path.startsWith(`${field}.`)) && b.some(field => path === field || path.startsWith(`${field}.`))))]

// History uses the same persisted log and permissions as reads/sync, without
// applying old patches to live client records or advancing the sync cursor.
export async function readHistory(config, input, readRecord) {
  const { table, id, req, before } = input
  if (id == null || !['string', 'number'].includes(typeof id)) throw new Error('History requires a record id')
  const limit = Math.min(200, Math.max(1, Math.trunc(Number(input.limit) || 50)))
  if (!Number.isFinite(limit)) throw new Error('Invalid history limit')
  if (before && (typeof before.createdAt !== 'string' || !Number.isFinite(Date.parse(before.createdAt))
    || !['string', 'number'].includes(typeof before.id))) throw new Error('Invalid history cursor')
  const target = await readRecord({ table, id, req })
  if (!target.doc) throw new Error(`History record not found: ${table}`)
  const ctx = { table, id, req, method: 'history', user: target.user, obj: target.doc, sources: [{ table, id }] }
  const decision = await runHooks(config, 'beforeHistory', ctx)
  if (decision?.allowed === false) throw new Error(decision.reason || 'History denied')
  const access = new Map([[keyOf({ table, id }), target]])
  const sources = new Map()
  for (const source of ctx.sources) {
    // readAs is a server-hook-only delegation, e.g. the current archive record
    // authorizes the history of its former live record. Client input cannot set it.
    const reference = source.readAs ?? source
    const key = keyOf(reference)
    if (!access.has(key)) access.set(key, await readRecord({ table: reference.table, id: reference.id, req }))
    const current = access.get(key)
    if (!current.doc) throw new Error(`History record not found: ${reference.table}`)
    sources.set(keyOf(source), { ...source, current, fields: intersect(current.fields, source.fields) })
  }
  if (!sources.size) return { changes: [], next: null }
  const clauses = [{ $or: [...sources.values()].map(source => ({ table: source.table, id: source.id })) }]
  if (before) clauses.push({ $or: [{ createdAt: { $lt: before.createdAt } }, { createdAt: before.createdAt, _id: { $lt: before.id } }] })
  const raw = await config.mongo.collection(config.logCollection).find({ $and: clauses })
    .sort({ createdAt: -1, _id: -1 }).limit(limit + 1).toArray()
  const page = raw.slice(0, limit), changes = []
  for (const row of page) {
    const source = sources.get(keyOf(row))
    const change = createChange({ ...row, action: row.action === 'add' ? 'insert' : row.action === 'remove' ? 'delete' : row.action })
    const changeCtx = { req, table: row.table, id: row.id, method: 'history', user: target.user, change,
      loadDoc: async () => source.current.doc }
    const allowed = await runHooks(config, 'readChange', changeCtx)
    if (allowed?.allowed === false) continue
    const fields = intersect(source.fields, changeCtx.fields)
    const filtered = filterChangeFields(change, fields)
    if (filtered) {
      if (filtered.old) filtered.old = projectFields(filtered.old, fields)
      const { sessionId, ...publicChange } = filtered
      changes.push(publicChange)
    }
  }
  const last = page.at(-1)
  ctx.result = { changes, next: raw.length > limit ? { createdAt: last.createdAt, id: last._id } : null }
  const after = await runHooks(config, 'afterHistory', ctx)
  if (after?.allowed === false) throw new Error(after.reason || 'History denied')
  return ctx.result
}
