// S1.4 (R34.35): `componentImport` for a member of a package import, executed against a stub package.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { componentImport, islandEntries } from '../src/build/bundle'

const stub = (external: { source: string; export: string; member?: string[] }) => ({ ir: { external }, file: '/x.tsx' }) as never

test('the import for a member path: named, default and namespace exports', () => {
  const named = componentImport(stub({ source: 'radix-ui', export: 'Dialog', member: ['Root'] }), 'C')
  expect(named).toBe('import { Dialog as C__ns } from "radix-ui"\nconst C = C__ns.Root\nif (C === undefined) throw new Error("brust: radix-ui has no export Dialog.Root")')
  expect(componentImport(stub({ source: 'cmdk', export: 'default', member: ['Item'] }), 'C')).toContain('import C__ns from "cmdk"')
  const ns = componentImport(stub({ source: 'react-resizable-panels', export: '*', member: ['Group'] }), 'C')
  expect(ns).toContain('import * as C__ns from "react-resizable-panels"')
  expect(ns).toContain('has no export Group")')
  // a plain package export is unchanged
  expect(componentImport(stub({ source: 'lucide-react', export: 'Heart' }), 'C')).toBe('import { Heart as C } from "lucide-react"')
})

let dir = ''
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'member-import-'))
  mkdirSync(join(dir, 'node_modules/stubpkg'), { recursive: true })
  writeFileSync(join(dir, 'node_modules/stubpkg/package.json'), JSON.stringify({ name: 'stubpkg', type: 'module', main: 'index.js' }))
  writeFileSync(join(dir, 'node_modules/stubpkg/index.js'), 'export const Dialog = { Root: () => "root" }\nexport default { Item: () => "item" }\n')
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const load = async (external: { source: string; export: string; member: string[] }) => {
  const entry = join(dir, `entry-${external.export}-${external.member.join('-')}.mjs`)
  writeFileSync(entry, `${componentImport(stub(external), 'Comp')}\nexport default Comp\n`)
  return (await import(entry)).default
}

test('the generated import reads the member off the export', async () => {
  expect((await load({ source: 'stubpkg', export: 'Dialog', member: ['Root'] }))()).toBe('root')
  expect((await load({ source: 'stubpkg', export: 'default', member: ['Item'] }))()).toBe('item')
})

test('a member the package does not have throws the named error when the module loads', async () => {
  await expect(load({ source: 'stubpkg', export: 'Dialog', member: ['Nope'] })).rejects.toThrow('brust: stubpkg has no export Dialog.Nope')
})

const comp = (id: string, tier: unknown, children: { id: string | null }[] = [], external?: object) =>
  [id, { id, ir: { tier, children, external } }] as never

test('a package member only gets an island entry when a static or native component embeds it', () => {
  const react = { React: { reason: 'x', client_only: false } }
  const compiled = new Map([
    comp('page', 'Static', [{ id: 'placed' }]),
    comp('placed', react, [], { source: 'radix-ui', export: 'Dialog', member: ['Root'] }),
    comp('wrapper', react, [{ id: 'inside' }]),
    comp('inside', react, [], { source: 'radix-ui', export: 'Dialog', member: ['Trigger'] }),
    comp('local', react),
  ])
  expect(islandEntries(compiled).map((c) => c.id)).toEqual(['placed', 'wrapper', 'local'])
})
