// F481 (F480 follow-up): the `server-only-in-client` refusal that a load writer causes names EVERY island whose chunk carries the
// writer and EVERY writer the server-only import is reached through, capped at three and then "and N more", in sorted order.
// Before, `importerOf` and the writer map were first-wins: one island, and the writer Bun happened to resolve first.
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runBuild } from '../src/build'
import { loadWriterReason, namedCapped } from '../src/build/bundle'

const made: string[] = []
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true })
})

const WRITE = 'addrsOf.cache = new Map()\n'

/** An app with `islands` React islands (each `useTransition`, so none lowers native) importing `lib/apps.ts`, and `writers` server
 * modules the routes entry imports; each writes into `lib/apps.ts` and imports `server/shared.ts`, which imports node:os. */
function app(name: string, islands: number, writers: number): string {
  const dir = join(import.meta.dir, 'fixtures', `.f481-${name}`)
  made.push(dir)
  rmSync(dir, { recursive: true, force: true })
  const files: Record<string, string> = {
    'lib/apps.ts': 'export function addrsOf(app: string): string[] {\n  return [`${app}.local`]\n}\n',
    'server/shared.ts': "import { hostname } from 'node:os'\nexport const host = hostname()\n",
  }
  const routesImports: string[] = []
  for (let w = 0; w < writers; w++) {
    files[`server/net${w}.ts`] = `import { addrsOf } from '../lib/apps'\nimport { host } from './shared'\n${WRITE}export const status${w} = host + addrsOf('w${w}')\n`
    routesImports.push(`import './server/net${w}'`)
  }
  const tags: string[] = []
  for (let i = 0; i < islands; i++) {
    files[`Gate${i}.tsx`] = `import { useTransition } from 'react'\nimport { addrsOf } from './lib/apps'\n\nexport default function Gate${i}() {\n  const [pending] = useTransition()\n  return <p>{addrsOf('g${i}')[0]} {String(pending)}</p>\n}\n`
    routesImports.push(`import Gate${i} from './Gate${i}'`)
    tags.push(`<Gate${i} />`)
  }
  files['Page.tsx'] = `${routesImports.filter((l) => l.includes('Gate')).join('\n')}\n\nexport default function Page() {\n  return <main>${tags.join('')}</main>\n}\n`
  files['routes.tsx'] = `import { defineRoutes } from '@brust/core/routes'\n${routesImports.filter((l) => !l.includes('Gate')).join('\n')}\nimport Page from './Page'\n\nexport const routes = defineRoutes([{ path: '/', Component: Page }])\n`
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true })
    writeFileSync(join(dir, f), text)
  }
  return dir
}

async function refusal(dir: string): Promise<string> {
  try {
    await runBuild({ appRoot: dir, entry: 'routes.tsx', outDir: join(dir, 'dist'), log: () => {}, force: true })
  } catch (e) {
    expect((e as { rule?: string }).rule).toBe('server-only-in-client')
    return (e as Error).message
  }
  throw new Error('the build passed: the writer was not shipped to the islands')
}

test('namedCapped: sorted, deduplicated, at most three names then "and N more"', () => {
  expect(namedCapped(['b', 'a', 'b'])).toBe('a, b')
  expect(namedCapped(['e', 'd', 'c', 'b', 'a'])).toBe('a, b, c and 2 more')
  expect(namedCapped(['d', 'c', 'b', 'a'])).toBe('a, b, c and 1 more')
  expect(namedCapped(['c', 'b', 'a'])).toBe('a, b, c')
})

test('loadWriterReason: one island keeps the F480 sentence; several islands and writers are all named, writers capped too', () => {
  const w = (rel: string, islands: string[]) => ({ rel, islands, writes: ['lib/apps.ts'] })
  expect(loadWriterReason([w('s/a.ts', ['g1'])])).toBe('s/a.ts is loaded into the React island g1 because it is judged to write lib/apps.ts when it loads: F230 load writes')
  expect(loadWriterReason([w('s/a.ts', ['g2', 'g1'])])).toContain('into the React islands g1, g2 because')
  const many = loadWriterReason(['e', 'd', 'c', 'b', 'a'].map((n) => w(`s/${n}.ts`, ['g1'])))
  expect(many.indexOf('s/a.ts')).toBeLessThan(many.indexOf('s/b.ts'))
  expect(many).toContain('s/c.ts')
  expect(many).not.toContain('s/d.ts')
  expect(many).toEndWith('; and 2 more load writers')
})

test('two islands that carry the writer are both named', async () => {
  const msg = await refusal(app('two-islands', 2, 1))
  expect(msg).toMatch(/server\/shared\.ts imports node:os \(server\/net0\.ts is loaded into the React islands gate0_[0-9a-f]{8}, gate1_[0-9a-f]{8} because it is judged to write lib\/apps\.ts/)
}, 120_000)

test('two writers that share a server-only dependency are both named, in sorted order', async () => {
  const msg = await refusal(app('two-writers', 1, 2))
  expect(msg).toMatch(/server\/shared\.ts imports node:os \(server\/net0\.ts is loaded into the React island gate0_[0-9a-f]{8} because [^;]*; server\/net1\.ts is loaded into the React island gate0_[0-9a-f]{8} because/)
}, 120_000)

test('five islands: three are named, then "and 2 more"', async () => {
  const msg = await refusal(app('five-islands', 5, 1))
  expect(msg).toMatch(/into the React islands gate0_[0-9a-f]{8}, gate1_[0-9a-f]{8}, gate2_[0-9a-f]{8} and 2 more because/)
  expect(msg).not.toContain('gate3_')
}, 120_000)
