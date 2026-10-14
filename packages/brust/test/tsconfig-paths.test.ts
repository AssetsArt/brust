// shadcn S1 (R34.76): the tsconfig `paths` the build hands the compiler, and the agreement check against the bundler.
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkAliasAgreement, readPathAliases } from '../src/build/tsconfig-paths'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})
function app(tsconfig: string | null, name = 'tsconfig.json'): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'brust-tsp-')))
  dirs.push(d)
  if (tsconfig !== null) writeFileSync(join(d, name), tsconfig)
  return d
}

test('paths + baseUrl become root-relative templates; comments and trailing commas are fine', () => {
  const d = app(`{ // c\n "compilerOptions": { "baseUrl": "src", "paths": { "@/*": ["./*"], "@app": ["app/main.tsx",], }, }, }`)
  expect(readPathAliases(d)).toEqual({
    aliases: [
      { pattern: '@/*', targets: ['src/*'] },
      { pattern: '@app', targets: ['src/app/main.tsx'] },
    ],
    notes: [],
  })
})

test('without baseUrl the targets are relative to the tsconfig; jsconfig.json is read when there is no tsconfig', () => {
  expect(readPathAliases(app(`{ "compilerOptions": { "paths": { "~/*": ["./*"] } } }`)).aliases).toEqual([{ pattern: '~/*', targets: ['*'] }])
  expect(readPathAliases(app(`{ "compilerOptions": { "paths": { "~/*": ["./app/*"] } } }`, 'jsconfig.json')).aliases).toEqual([{ pattern: '~/*', targets: ['app/*'] }])
  expect(readPathAliases(app(null))).toEqual({ aliases: [], notes: [] })
})

test('extends and references are not followed, and the note says so', () => {
  const ext = readPathAliases(app(`{ "extends": "./tsconfig.app.json" }`))
  expect(ext.aliases).toEqual([])
  expect(ext.notes[0]).toContain('extends')
  const refs = readPathAliases(app(`{ "references": [{ "path": "./tsconfig.app.json" }] }`))
  expect(refs.notes[0]).toContain('references')
  // An own `paths` still works next to an `extends`, with the note.
  const both = readPathAliases(app(`{ "extends": "./base.json", "compilerOptions": { "paths": { "@/*": ["./*"] } } }`))
  expect(both.aliases).toEqual([{ pattern: '@/*', targets: ['*'] }])
  expect(both.notes.length).toBe(1)
})

test('patterns the compiler does not follow are named, and targets outside the app are dropped', () => {
  const r = readPathAliases(app(`{ "compilerOptions": { "paths": { "a/*/b/*": ["./*"], "@/*": ["../outside/*", "node_modules/x/*", "/abs/*", "./ok/*"] } } }`))
  expect(r.aliases).toEqual([{ pattern: '@/*', targets: ['ok/*'] }])
  expect(r.notes.length).toBe(1)
  expect(r.notes[0]).toContain('a/*/b/*')
})

test('an unparseable tsconfig is a note, not a crash', () => {
  const r = readPathAliases(app('{ not json'))
  expect(r.aliases).toEqual([])
  expect(r.notes[0]).toContain('could not be parsed')
})

test('the agreement check passes when the bundler resolves the specifier to the same file and fails otherwise', () => {
  const d = app(`{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./*"] } } }`)
  mkdirSync(join(d, 'components'), { recursive: true })
  writeFileSync(join(d, 'components/a.tsx'), 'export const a = 1\n')
  writeFileSync(join(d, 'components/b.tsx'), 'export const b = 1\n')
  writeFileSync(join(d, 'page.tsx'), '')
  expect(() => checkAliasAgreement(d, [{ from: 'page.tsx', spec: '@/components/a', target: 'components/a.tsx' }])).not.toThrow()
  // The compiler said b, the bundler resolves a.
  expect(() => checkAliasAgreement(d, [{ from: 'page.tsx', spec: '@/components/a', target: 'components/b.tsx' }])).toThrow(/components\/b\.tsx for the compiler/)
  // The bundler cannot resolve it at all.
  expect(() => checkAliasAgreement(d, [{ from: 'page.tsx', spec: '@/components/none', target: 'components/a.tsx' }])).toThrow(/bundler cannot resolve/)
})
