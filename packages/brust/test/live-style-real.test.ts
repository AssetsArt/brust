// F296 (spread-live, option A) on the REAL Radix source: `SwitchBubbleInput` renders `<Primitive.input … style={{ ...props.style,
// ...controlSize, … }} onClick={composeEventHandlers(…)} />`. `useSize` makes the style live; before F296 that live style
// linked `Primitive.input` and refused the composed `onClick` (`spread-handler`), so the whole Root fell back to React.
// With the style bound by the parent, the BubbleInput compiles Native with `x-bind-style`, `x-on-click` and `x-ref` on its
// `<input>`, and `Primitive.input` stays Static (no chunk). One edit is applied to the package source first: S1
// (`defaultChecked ?? defaultCheckedRef.current`, a never-written ref seeded by live state, a separate gap: F277 follow-up).
import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileTree } from '../native/index.js'
import { preparePackageSources } from '../src/build/pkg-src'

const fixture = join(import.meta.dir, '../../../tests/fixtures/shadcn')
const roots: string[] = []
afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true })
})

const S1 = 'defaultChecked={defaultChecked ?? defaultCheckedRef.current}'

test('the real SwitchBubbleInput compiles Native with the live style and the composed onClick on its input; Primitive.input stays static', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'brust-live-style-')))
  roots.push(root)
  symlinkSync(join(fixture, 'node_modules'), join(root, 'node_modules'))
  writeFileSync(join(root, 'package.json'), '{"name":"live-style-real","type":"module"}')
  mkdirSync(join(root, 'pages'))
  writeFileSync(join(root, 'pages/switch.tsx'), `import { Switch } from 'radix-ui'\nexport default function P() { return <Switch.Root><Switch.Thumb /></Switch.Root> }\n`)
  const first = compileTree('pages/switch.tsx', root, '/_brust/runtime.js', [], null, null, null, [], '[]')
  expect(first.error).toBeUndefined()
  const external = [...new Set(first.components.flatMap((c) => { const ir = JSON.parse(c.ir); return ir.external ? [ir.external.source] : [] }))]
  const packages = JSON.stringify(preparePackageSources(root, external))
  // the package source of `@radix-ui/react-switch` the build wrote
  const pkgSrc = join(root, '.brust/pkg-src')
  const dir = readdirSync(pkgSrc).find((d) => existsSync(join(pkgSrc, d, 'src/switch.tsx')))
  expect(dir, 'the switch source is written under .brust/pkg-src').toBeDefined()
  const file = join(pkgSrc, dir!, 'src/switch.tsx')
  const src = readFileSync(file, 'utf8')
  expect(src).toContain(S1)
  writeFileSync(file, src.replace(S1, 'defaultChecked={defaultChecked}'))
  writeFileSync(join(root, 'pages/bi.tsx'), `import { BubbleInput } from '../.brust/pkg-src/${dir}/src/switch'\nexport default function P() { return <div><BubbleInput /></div> }\n`)
  const tree = compileTree('pages/bi.tsx', root, '/_brust/runtime.js', [], null, null, null, [], '[]', packages)
  expect(tree.error).toBeUndefined()
  const tier = (c: { ir: string }) => { const t = JSON.parse(c.ir).tier; return typeof t === 'string' ? t : 'React' }
  const bubble = tree.components.find((c) => c.id.startsWith('bubbleInput'))
  const primitive = tree.components.find((c) => c.id.startsWith('primitive'))
  expect(bubble, 'BubbleInput is in the tree').toBeDefined()
  const fallbacks = bubble!.diagnostics.filter((d) => d.class === 'fallback').map((d) => `${d.rule}: ${d.message}`)
  expect(fallbacks).toEqual([])
  expect(tier(bubble!)).toBe('Native')
  expect(primitive && tier(primitive)).toBe('Static')
  // bound by the parent, on the input, in the parent's scope: nothing links Primitive.input
  expect(bubble!.jinja).toMatch(/x-bind-style="_c\d+"/)
  expect(bubble!.jinja).toMatch(/x-on-click="_h\d+"/)
  expect(bubble!.jinja).toMatch(/x-ref="_rf\d+"/)
  expect(bubble!.jinja).not.toContain('x-props-bind')
  expect(primitive!.clientJs ?? null).toBeNull()
})
