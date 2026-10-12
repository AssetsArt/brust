import { expect, test } from 'bun:test'
import { verifyCacheBindings } from '../src/build/cf-wrangler'

const KV = { kv_namespaces: [{ binding: 'BRUST_CACHE', id: 'x' }] }
const DOB = { durable_objects: { bindings: [{ name: 'BRUST_CACHE_DO', class_name: 'BrustCacheDO' }] } }
const MIG = { migrations: [{ tag: 'v1', new_sqlite_classes: ['BrustCacheDO'] }] }
const msg = (r: ReturnType<typeof verifyCacheBindings>) => (r.ok ? '' : r.message)

test('an empty config + a KV need prints the exact kv_namespaces snippet', () => {
  const r = verifyCacheBindings({}, { kv: 'BRUST_CACHE' })
  expect(r.ok).toBe(false)
  expect(msg(r)).toContain('"kv_namespaces": [{ "binding": "BRUST_CACHE", "id": "<wrangler kv namespace create brust-cache>" }]')
})
test('an empty config + a DO need prints the durable_objects and migrations snippets', () => {
  const m = msg(verifyCacheBindings({}, { do: 'BRUST_CACHE_DO' }))
  expect(m).toContain('"durable_objects": { "bindings": [{ "name": "BRUST_CACHE_DO", "class_name": "BrustCacheDO" }] }')
  expect(m).toContain('"migrations": [{ "tag": "brust-cache-v1", "new_sqlite_classes": ["BrustCacheDO"] }]')
})
test('bindings + migrations, or bindings + exports, are ok; new_classes is refused naming new_sqlite_classes', () => {
  expect(verifyCacheBindings({ ...KV, ...DOB, ...MIG }, { kv: 'BRUST_CACHE', do: 'BRUST_CACHE_DO' }).ok).toBe(true)
  expect(verifyCacheBindings({ ...DOB, exports: { BrustCacheDO: { type: 'durable-object', storage: 'sqlite' } } }, { do: 'BRUST_CACHE_DO' }).ok).toBe(true)
  const r = verifyCacheBindings({ ...DOB, migrations: [{ tag: 'v1', new_classes: ['BrustCacheDO'] }] }, { do: 'BRUST_CACHE_DO' })
  expect(msg(r)).toContain('new_sqlite_classes')
})
test('every env.* block is checked and named', () => {
  const r = verifyCacheBindings({ ...KV, env: { staging: {} } }, { kv: 'BRUST_CACHE' })
  expect(msg(r)).toContain('env.staging')
  expect(msg(r)).not.toContain('the top level')
  expect(verifyCacheBindings({ ...KV, env: { staging: { ...KV } } }, { kv: 'BRUST_CACHE' }).ok).toBe(true)
})
test('a binding that points at another script is refused; custom binding names are honoured', () => {
  expect(verifyCacheBindings({ ...MIG, durable_objects: { bindings: [{ name: 'BRUST_CACHE_DO', class_name: 'BrustCacheDO', script_name: 'other' }] } }, { do: 'BRUST_CACHE_DO' }).ok).toBe(false)
  expect(verifyCacheBindings({ kv_namespaces: [{ binding: 'MY_KV', id: 'x' }] }, { kv: 'MY_KV' }).ok).toBe(true)
  expect(msg(verifyCacheBindings({ kv_namespaces: [{ binding: 'MY_KV', id: 'x' }] }, { kv: 'BRUST_CACHE' }))).toContain('BRUST_CACHE')
})
test('the config is never mutated and a user DO class + migration are left alone', () => {
  const c = { ...KV, ...DOB, migrations: [{ tag: 'u1', new_sqlite_classes: ['Mine'] }, { tag: 'v1', new_sqlite_classes: ['BrustCacheDO'] }], durable_objects: { bindings: [...DOB.durable_objects.bindings, { name: 'MINE', class_name: 'Mine' }] } }
  const before = structuredClone(c)
  expect(verifyCacheBindings(c, { kv: 'BRUST_CACHE', do: 'BRUST_CACHE_DO' }).ok).toBe(true)
  expect(c).toEqual(before)
})
