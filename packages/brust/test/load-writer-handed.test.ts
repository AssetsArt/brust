// F480 (Assets Art, alpha.32): a server-only module handed `addrsOf`, an exported function of `lib/apps.ts`, to a
// function of `lib/network.ts` when it loads. F230 judged `lib/apps.ts` written by it, so the writer was imported first
// into the browser chunk of every React island that imports `lib/apps.ts`, and the browser build refused its server-only
// import. A function handed on is code to call, not an object to change: the build passes and no chunk carries the
// writer. A real write into the function as an object keeps the writer, and the refusal names that chain.
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runBuild } from '../src/build'

const made: string[] = []
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true })
})

const MARK = 'SERVER-NETWORK-F480'

/** An app with a React island (`useTransition`) that imports `lib/apps.ts`, and a server-only setup module the routes
 * entry imports; `network` is that module's body after its imports. */
function app(name: string, network: string): string {
  const dir = join(import.meta.dir, 'fixtures', `.f480-${name}`)
  made.push(dir)
  rmSync(dir, { recursive: true, force: true })
  const files: Record<string, string> = {
    'lib/apps.ts': 'export function addrsOf(app: string): string[] {\n  return [`${app}.local`]\n}\n',
    'lib/network.ts': "export function probe(pick: (app: string) => string[]): string {\n  return pick('console').join(',')\n}\n",
    'server/network.ts': `import { hostname } from 'node:os'\nimport { addrsOf } from '../lib/apps'\nimport { probe } from '../lib/network'\n${network}`,
    'Gate.tsx': `import { useTransition } from 'react'\nimport { addrsOf } from './lib/apps'\n\nexport default function Gate() {\n  const [pending] = useTransition()\n  return <p data-testid="gate">{addrsOf('gate')[0]} {String(pending)}</p>\n}\n`,
    'Page.tsx': "import Gate from './Gate'\n\nexport default function Page() {\n  return <main><Gate /></main>\n}\n",
    'routes.tsx': "import { defineRoutes } from '@brust/core/routes'\nimport './server/network'\nimport Page from './Page'\n\nexport const routes = defineRoutes([{ path: '/', Component: Page }])\n",
  }
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true })
    writeFileSync(join(dir, f), text)
  }
  return dir
}

async function build(dir: string) {
  const log: string[] = []
  const dist = join(dir, 'dist')
  try {
    await runBuild({ appRoot: dir, entry: 'routes.tsx', outDir: dist, log: (l) => log.push(l), force: true })
    return { error: undefined, log: log.join('\n'), dist }
  } catch (e) {
    return { error: e as Error, log: log.join('\n'), dist }
  }
}

test('F480: a server-only module handing an imported function to app code is not shipped to the island', async () => {
  const b = await build(app('handed', `export const status = \`\${hostname()} ${MARK} \${probe(addrsOf)}\`\n`))
  expect(b.error?.message, b.log).toBeUndefined()
  expect(b.log).not.toContain('load-writer-in-client')
  const client = join(b.dist, 'client')
  const chunks = readdirSync(client).filter((f) => f.endsWith('.js'))
  expect(chunks.some((f) => f.startsWith('react-gate_'))).toBe(true)
  expect(chunks.filter((f) => readFileSync(join(client, f), 'utf8').includes(MARK))).toEqual([])
})

test('F480: a write into the function as an object keeps the writer, and the refusal names the load-writer chain', async () => {
  const b = await build(app('written', `addrsOf.cache = new Map()\nexport const status = \`\${hostname()} ${MARK} \${probe(addrsOf)}\`\n`))
  expect((b.error as { rule?: string } | undefined)?.rule, b.error?.message).toBe('server-only-in-client')
  const msg = b.error!.message
  expect(msg).toMatch(/server\/network\.ts imports node:os \(server\/network\.ts is loaded into the React island gate_[0-9a-f]{8} because it is judged to write lib\/apps\.ts when it loads: F230 load writes\)/)
})
