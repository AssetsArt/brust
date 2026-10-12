import { expect, test } from 'bun:test'
import { type CfConfigJson, type CfEntryInput, cfEntrySource } from '../src/build/cf-entry'

const config: CfConfigJson = { abi: 1, generator: 'brust/2.0.0-alpha.2', l1Capacity: 256, jobCacheCapacity: 512, stats: false, edgeCache: 'off' }
const base: CfEntryInput = {
  entry: '/app/routes.tsx',
  jobsEntry: '/app/dist/cf/.stage/jobs.ts',
  actionsEntry: '/app/actions.ts',
  prefix: '/_brust/action',
  manifestPath: '/app/dist/manifest.json',
  templatesPath: '/app/dist/cf/.stage/templates.json',
  config: { ...config, actions: { prefix: '/_brust/action', maxBodyBytes: 1048576, maxResponseBytes: 8388608, crossSite: 'reject' } },
}

test('actions + stores', () => expect(cfEntrySource(base)).toMatchSnapshot())
test('no actions', () => expect(cfEntrySource({ ...base, actionsEntry: null, config })).toMatchSnapshot())
test('prefix /api', () => expect(cfEntrySource({ ...base, prefix: '/api' })).toMatchSnapshot())

test('no-actions entry carries no elysia / actions import and stubs the action', () => {
  const s = cfEntrySource({ ...base, actionsEntry: null, config })
  expect(s).toContain('export const action = noActions')
  expect(s).not.toContain('elysia')
  expect(s).not.toContain('server-handlers/actions')
  expect(s).not.toContain('mountActions')
})

test('CONFIG round-trips JSON.parse and the entry stays within 25 lines', () => {
  const s = cfEntrySource(base)
  const line = s.split('\n').find((l) => l.startsWith('export const CONFIG = '))!
  expect(JSON.parse(JSON.parse(line.slice('export const CONFIG = '.length)))).toEqual(base.config)
  expect(s.trimEnd().split('\n').length).toBeLessThanOrEqual(25)
})

test('hostile paths are quoted, not interpolated', () => {
  const s = cfEntrySource({ ...base, entry: '/a"b\n/c.tsx' })
  expect(s).toContain('import * as R from "/a\\"b\\n/c.tsx"')
})
