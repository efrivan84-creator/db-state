import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDbStateServer } from '../packages/server-mongo/src/index.js'
import { createMemoryMongo } from '../demo/server/memoryMongo.js'
import { createTableApi } from '../packages/vue/src/table.js'

const now = '2026-10-05T00:00:00.000Z'
const change = (id, set, extra = {}) => ({ _id: id, table: 'order', id: 1, action: 'update', createdAt: now, userId: 7, sessionId: 'current', set, ...extra })
function setup(seed = {}, options = {}) {
  const mongo = createMemoryMongo({ order: [{ _id: 1, owner: 7, name: 'current' }], ...seed })
  const api = createDbStateServer({ mongo, prefix: 'admin', tables: ['order', 'archive', 'task'], getUser: async () => ({ _id: 7, access: { fullaccess: 1 } }), ...options })
  return { mongo, api }
}
test('history reads configured log, includes own session, paginates tied timestamps without applying changes', async () => {
  const { mongo, api } = setup({ admin_log: ['1', '2', '3'].map(id => change(id, { name: id })) })
  const first = await api.history({ table: 'order', id: 1, limit: 2, sessionId: 'current' })
  const second = await api.history({ table: 'order', id: 1, before: first.next, limit: 2 })
  assert.deepEqual([...first.changes, ...second.changes].map(row => row._id), ['3', '2', '1'])
  assert.equal(second.next, null)
  assert.equal(first.changes[0].sessionId, undefined)
  assert.equal((await mongo.collection('order').findOne({ _id: 1 })).name, 'current')
})
test('history rechecks current row permissions and requires an existing authorized record', async () => {
  const { api } = setup({}, { getUser: async () => ({ _id: 8, access: { order: { read: { owner: '$adminid' } } } }) })
  await assert.rejects(api.history({ table: 'order', id: 1 }), /denied/i)
  await assert.rejects(setup().api.history({ table: 'order', id: 99 }), /not found/i)
})
test('history projects inserts, updates and old values, including nested field permissions', async () => {
  const { api } = setup({ admin_log: [
    change('1', undefined, { action: 'add', obj: { _id: 1, profile: { public: 'yes', secret: 'no' } } }),
    change('2', { profile: { public: 'new', secret: 'no' } }, { old: { _id: 1, profile: { public: 'old', secret: 'no' } } }),
    change('3', { secret: 'no' })
  ] }, { getUser: async () => ({ _id: 7, access: { order: { read: {}, read_fields: ['profile.public'] } } }) })
  const { changes } = await api.history({ table: 'order', id: 1 })
  assert.deepEqual(changes.map(row => row._id), ['2', '1'])
  assert.deepEqual(changes[0].set, { 'profile.public': 'new' })
  assert.deepEqual(changes[0].old, { _id: 1, profile: { public: 'old' } })
  assert.deepEqual(changes[1].obj, { _id: 1, profile: { public: 'yes' } })
})
test('server hooks extend history to an archive source; client-supplied sources are ignored', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'db-state-history-'))
  await mkdir(join(dir, 'archive'))
  await writeFile(join(dir, 'archive', 'beforeHistory.js'), 'export default ctx => { ctx.sources = [{table: "order", id: ctx.id, readAs: {table: "archive", id: ctx.id}}] }')
  const { api } = setup({ order: [], archive: [{ _id: 1 }], admin_log: [change('1', { name: 'before archive' })] }, { hooksDir: dir, getUser: async () => ({ _id: 7, access: { archive: { read: {}, read_fields: ['name'] } } }) })
  const result = await api.history({ table: 'archive', id: 1, sources: [{ table: 'secret', id: 2 }] })
  assert.equal(result.changes[0].table, 'order')
  assert.deepEqual(result.changes[0].set, { name: 'before archive' })
})
test('history honors readChange hooks as well as load permissions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'db-state-history-'))
  await mkdir(join(dir, 'order'))
  await writeFile(join(dir, 'order', 'readChange.js'), 'export default ctx => { ctx.fields = ["name"]; return ctx.change._id !== "2" }')
  const { api } = setup({ admin_log: [change('1', { name: 'yes', secret: 'no' }), change('2', { name: 'hidden' })] }, { hooksDir: dir })
  assert.deepEqual((await api.history({ table: 'order', id: 1 })).changes.map(row => row.set), [{ name: 'yes' }])
})
test('Vue history uses standard transport and does not replay journal rows into live state', async () => {
  const calls = [], tables = { order: { 1: { _id: 1, name: 'current' } } }
  const result = { changes: [change('1', { name: 'past' })], next: null }
  const table = createTableApi({ options: {}, table: 'order', tables, loadingByKey: new Map(), keyRefs: new Map(),
    state: { waitForAuthorized: async () => {}, socket: { rpc: async (method, payload) => { calls.push({ method, payload }); return result } } } })
  assert.equal(await table.history({ id: 1, limit: 10, table: 'secret' }), result)
  assert.equal(calls[0].method, 'history')
  assert.equal(calls[0].payload.table, 'order')
  assert.equal(tables.order[1].name, 'current')
})
