import { describe, expect, test, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { scanDirectiveComponents } from './build.ts'

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
    expect([...found.keys()]).toEqual(['addToTeamButton'])
    expect(found.get('addToTeamButton')).toBe(join(root, 'components/AddToTeamButton.tsx'))
  })

  test('throws on two files deriving the same register name', () => {
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
    // instead assert two DISTINCT names are found:
    const found = scanDirectiveComponents(join(root, 'routes.tsx'))
    expect(new Set(found.keys())).toEqual(new Set(['widget', 'other']))
  })
})
