import { describe, expect, it, test, afterEach } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync as rf,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { buildDirectives, directiveName, scanDirectiveComponents } from './build.ts'

describe('directiveName', () => {
  const root = '/proj'
  it('is camelCase basename + _ + 8 hex, matches the runtime chunk-name guard', () => {
    const n = directiveName('/proj/components/AddToTeamButton.tsx', root)
    expect(n).toMatch(/^addToTeamButton_[0-9a-f]{8}$/)
    expect(n).toMatch(/^[A-Za-z0-9_-]+$/) // loadBehavior guard in runtime.ts
  })
  it('is deterministic for the same relative path', () => {
    expect(directiveName('/proj/a/B.tsx', root)).toBe(directiveName('/proj/a/B.tsx', root))
  })
  it('differs for different paths sharing a basename (collision avoided)', () => {
    expect(directiveName('/proj/x/Button.tsx', root)).not.toBe(
      directiveName('/proj/y/Button.tsx', root),
    )
  })
  it('hashes the cwd-relative path (stable across an absolute prefix move)', () => {
    expect(directiveName('/ci/app/c/W.tsx', '/ci/app')).toBe(
      directiveName('/srv/app/c/W.tsx', '/srv/app'),
    )
  })
})

// IMPORTANT: temp dirs MUST live UNDER the repo (not os.tmpdir()/`/tmp`). Task 8's
// buildDirectives runs `Bun.build` on a generated entry that imports `brustjs/native`
// and fixtures that import `brustjs/store`. Bun resolves those bare specifiers via
// package SELF-REFERENCE (package name "brustjs" + exports) — which only works for
// files located inside the package tree. A `/tmp` fixture cannot reach the package
// and fails with "Cannot find module 'brustjs/native'". `.brust/` is gitignored, so
// stray dirs from a crashed run are never committed.
const TMP_BASE = resolve(import.meta.dir, '../../.brust/native-test')
const dirs: string[] = []
function tmp(): string {
  mkdirSync(TMP_BASE, { recursive: true })
  const d = mkdtempSync(join(TMP_BASE, 'd-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('scanDirectiveComponents', () => {
  test('finds files with `export const behavior`, derives camelCase name, ignores others', () => {
    const root = tmp()
    mkdirSync(join(root, 'components'))
    writeFileSync(
      join(root, 'routes.tsx'),
      `import AddToTeamButton from './components/AddToTeamButton'\nimport Plain from './components/Plain'\n`,
    )
    writeFileSync(
      join(root, 'components/AddToTeamButton.tsx'),
      `export const behavior = () => ({})\nexport default function AddToTeamButton(){ return null as any }\n`,
    )
    writeFileSync(
      join(root, 'components/Plain.tsx'),
      `export default function Plain(){ return null as any }\n`,
    )
    const found = scanDirectiveComponents(join(root, 'routes.tsx'))
    const compPath = join(root, 'components/AddToTeamButton.tsx')
    const expectedName = directiveName(compPath, process.cwd())
    expect([...found.keys()]).toEqual([expectedName])
    expect(expectedName).toMatch(/^addToTeamButton_[0-9a-f]{8}$/)
    expect(found.get(expectedName)).toBe(compPath)
  })

  test('discovers multiple behaviors across the import graph (distinct names)', () => {
    const root = tmp()
    mkdirSync(join(root, 'a'))
    mkdirSync(join(root, 'b'))
    writeFileSync(
      join(root, 'routes.tsx'),
      `import Widget from './a/Widget'\nimport Other from './b/Other'\n`,
    )
    // Other.tsx re-exports a Widget that also has a behavior under the same basename
    writeFileSync(
      join(root, 'a/Widget.tsx'),
      `export const behavior = () => ({})\nexport default function Widget(){return null as any}\n`,
    )
    writeFileSync(
      join(root, 'b/Other.tsx'),
      `import Widget from '../a/Widget'\nexport const behavior = () => ({})\nexport default function Other(){return null as any}\n`,
    )
    // both 'Widget' (via a) and 'Other' (via b) qualify with distinct names → no throw here;
    // instead assert two DISTINCT hashed names are found:
    const found = scanDirectiveComponents(join(root, 'routes.tsx'))
    const widgetName = directiveName(join(root, 'a/Widget.tsx'), process.cwd())
    const otherName = directiveName(join(root, 'b/Other.tsx'), process.cwd())
    expect(widgetName).toMatch(/^widget_[0-9a-f]{8}$/)
    expect(otherName).toMatch(/^other_[0-9a-f]{8}$/)
    expect(new Set(found.keys())).toEqual(new Set([widgetName, otherName]))
  })
})

describe('buildDirectives', () => {
  test('emits a react-free runtime + a per-component chunk; name lives in the chunk', async () => {
    const root = tmp()
    const outDir = join(root, 'islands')
    // A behavior importing only signal/computed from brustjs/store (react-free).
    const compPath = join(root, 'Probe.tsx')
    writeFileSync(
      compPath,
      `import { signal } from 'brustjs/store'\n` +
        `export const behavior = () => ({ n: signal(0) })\n` +
        `export default function Probe(){ return null as any }\n`,
    )
    const res = await buildDirectives(new Map([['probe', compPath]]), { outDir })
    expect(res.count).toBe(1)
    expect(res.files).toEqual(['_directives.js', 'probe.directive.js'])
    // Runtime exists, is react-free, and does NOT bundle the behavior (name is in the chunk).
    const runtime = join(outDir, '_directives.js')
    expect(existsSync(runtime)).toBe(true)
    const runtimeOut = rf(runtime, 'utf8')
    expect(/createRoot|hydrateRoot|react-dom/.test(runtimeOut)).toBe(false)
    expect(runtimeOut).not.toContain('probe') // behavior split OUT of the runtime
    // Per-component chunk exists, registers the name, react-free.
    const chunk = join(outDir, 'probe.directive.js')
    expect(existsSync(chunk)).toBe(true)
    const chunkOut = rf(chunk, 'utf8')
    expect(chunkOut).toContain('probe') // self-registers under its name
    expect(/createRoot|hydrateRoot|react-dom/.test(chunkOut)).toBe(false)
  })

  test('react-leak guard throws when a behavior pulls react (useStore)', async () => {
    const root = tmp()
    const outDir = join(root, 'islands')
    const compPath = join(root, 'Bad.tsx')
    writeFileSync(
      compPath,
      `import { useStore } from 'brustjs/client'\n` +
        `export const behavior = () => ({ x: useStore })\n` +
        `export default function Bad(){ return null as any }\n`,
    )
    await expect(buildDirectives(new Map([['bad', compPath]]), { outDir })).rejects.toThrow(
      /react/i,
    )
  })

  test('empty component set is a no-op (no file)', async () => {
    const root = tmp()
    const outDir = join(root, 'islands')
    const res = await buildDirectives(new Map(), { outDir })
    expect(res.count).toBe(0)
    expect(existsSync(join(outDir, '_directives.js'))).toBe(false)
  })
})
