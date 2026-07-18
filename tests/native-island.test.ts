import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawn, spawnSync } from 'bun'
import { directiveName } from '../runtime/native/build.ts'

/** Sub-project J / native islands E2E — proves the full `native: true` + CLIENT-ONLY
 * <Island> pipeline end-to-end:
 *
 *   NativeIslandPage.tsx (<Island component={Counter} props={count} />, no ssr)
 *     → jsx-rustc compile → .brust/jinja/NativeIslandPage.jinja
 *         (fallback-filled data-brust-csr mount + island_0_props placeholder — the
 *          instance-based context key for the single, source-order-0 instance)
 *     → T6 reconcile bakes {% raw %}…{% endraw %} importmap+bootstrap onto the .jinja
 *     → brust boot reads .brust/jinja/ into minijinja (the {% raw %} block MUST
 *        compile — if it didn't, this route would 500)
 *     → T7's native branch fills island_0_props with entity-encoded props JSON
 *     → served HTML = static shell + client-only placeholder + literal bootstrap
 *
 * This task proves the SERVED HTML SHAPE + that the baked template compiles at boot.
 * Browser interactivity (the createRoot hydration branch) is OUT OF SCOPE here — this
 * repo has no Playwright/puppeteer infra; that branch is unit-tested in T5. A browser
 * interactivity smoke is a documented follow-up.
 *
 * Mirrors tests/jinja-route.test.ts's boot harness (build native addon → brust
 * build → spawn → waitForReady → SIGINT), on a different port (3802) to avoid clashes.
 */

const REPO_ROOT = resolve(import.meta.dir, '..')
const FIXTURE_DIR = resolve(REPO_ROOT, 'tests/fixtures/app')
const BASE_URL = 'http://127.0.0.1:3802'

let proc: ReturnType<typeof spawn> | undefined

async function waitForReady(url: string, timeoutMs = 10000): Promise<void> {
  const start = Date.now()
  let lastErr: unknown
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/ping`)
      if (res.status === 200) return
    } catch (e) {
      lastErr = e
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`server didn't become ready at ${url}: ${String(lastErr)}`)
}

beforeAll(async () => {
  // Pre-flight 1: build the NAPI addon used by emitNativeTemplates.compileJsx.
  // Building only the legacy jsx-rustc binary would leave runtime/index.js
  // backed by a stale .node file and would not exercise current compiler code.
  const buildNative = spawnSync({
    cmd: ['bun', 'run', 'build:debug'],
    cwd: REPO_ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (buildNative.exitCode !== 0) {
    throw new Error(`bun run build:debug failed (exit ${buildNative.exitCode})`)
  }

  // Pre-flight 2: run brust build against the fixture entry. This compiles the
  // native pages to .brust/jinja/, bakes islands per T6, and bundles the island
  // chunks (the page's <Island component={Counter}> usage registers Counter).
  const buildRes = spawnSync({
    cmd: ['bun', 'run', resolve(REPO_ROOT, 'runtime/cli/index.ts'), 'build', 'index.ts'],
    cwd: FIXTURE_DIR,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (buildRes.exitCode !== 0) {
    const stdoutStr = buildRes.stdout ? new TextDecoder().decode(buildRes.stdout) : ''
    const stderrStr = buildRes.stderr ? new TextDecoder().decode(buildRes.stderr) : ''
    throw new Error(`brust build failed (exit ${buildRes.exitCode}):\n${stdoutStr}\n${stderrStr}`)
  }

  // Sanity-check the build pass: the native-island template + its islands
  // manifest must exist, and the baked .jinja must carry the {% raw %} block.
  const jinjaPath = resolve(FIXTURE_DIR, '.brust/jinja/NativeIslandPage.jinja')
  const islandsJsonPath = resolve(FIXTURE_DIR, '.brust/jinja/NativeIslandPage.islands.json')
  const manifestPath = resolve(FIXTURE_DIR, '.brust/jinja/_manifest.json')
  expect(existsSync(jinjaPath)).toBe(true)
  expect(existsSync(islandsJsonPath)).toBe(true)
  expect(existsSync(manifestPath)).toBe(true)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  expect(manifest.templates).toContain('NativeIslandPage')
  expect(readFileSync(jinjaPath, 'utf8')).toContain('{% raw %}')

  // Spawn brust against the fixture (port 3802 to avoid clashing with the 3801
  // used by jinja-route.test.ts).
  proc = spawn({
    cmd: ['bun', 'run', resolve(FIXTURE_DIR, 'index.ts')],
    cwd: FIXTURE_DIR,
    env: {
      ...process.env,
      BRUST_PORT: '3802',
      RUST_LOG: 'brust=warn',
    },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  await waitForReady(BASE_URL)
}, 120_000)

afterAll(async () => {
  if (proc) {
    proc.kill('SIGINT')
    try {
      await proc.exited
    } catch {
      // Process may have already exited.
    }
  }
})

test('GET /_test/native-island — client-only island serves inline and SSR-slot fallback inside CSR mount', async () => {
  const res = await fetch(`${BASE_URL}/_test/native-island`)

  // The bake-compile proof: if the baked {% raw %}…{% endraw %} importmap block
  // had failed to compile into the minijinja Environment at boot, this route
  // would 500. A 200 here proves the template compiled.
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('text/html')

  const body = await res.text()

  // Static shell rendered by jinja from the loader's `greeting`.
  expect(body).toContain('<h1>Hello islands</h1>')

  // Client-only island mount: id, CSR marker, and the entity-encoded props JSON
  // of { start: 3 } (single-encoding — NOT double-escaped to &amp;quot;).
  expect(body).toMatch(/data-brust-island="Counter_[a-f0-9]{8}"/)
  expect(body).toContain('data-brust-csr')
  expect(body).toContain('data-brust-props="{&quot;start&quot;:3}"')

  // The client-only mount keeps useful server HTML until bootstrap obtains a
  // valid Counter module. MenuSkeleton is native-inlined, while HookBadge uses
  // the existing SSR component slot/factory path because it calls useState.
  // MenuSkeleton also directly lowers a nested Counter island: its marker and
  // chunk must exist before the parent CSR takeover disposes its lifecycle.
  expect(body).toContain('<div class="menu-skeleton"><span>Hello islands</span>')
  expect(body).toMatch(/<span class="hbadge">Hello islands(?:<!-- -->)?0<\/span>/)
  expect(body.match(/data-brust-island="Counter_[a-f0-9]{8}"/g)).toHaveLength(2)

  const jinjaDir = resolve(FIXTURE_DIR, '.brust/jinja')
  const jinja = readFileSync(resolve(jinjaDir, 'NativeIslandPage.jinja'), 'utf8')
  const islands = JSON.parse(
    readFileSync(resolve(jinjaDir, 'NativeIslandPage.islands.json'), 'utf8'),
  ) as Array<{ component: string; instance: number }>
  const components = readFileSync(resolve(jinjaDir, 'NativeIslandPage.components.json'), 'utf8')
  const factory = readFileSync(resolve(jinjaDir, 'NativeIslandPage.factory.ts'), 'utf8')
  expect(jinja).toContain('class="menu-skeleton"')
  expect(jinja).toMatch(/comp_\d+_html/)
  expect(components).toContain('"HookBadge"')
  expect(components).not.toContain('"MenuSkeleton"')
  expect(factory).toContain('import HookBadge')
  expect(factory).toContain('h(HookBadge')
  expect(islands.map(({ instance }) => instance)).toEqual([0, 1])
  expect(islands[0]?.component).toBe(islands[1]?.component)

  // Bootstrap baked by T6: the importmap + the module bootstrap script appear
  // LITERALLY (minijinja strips the {% raw %}/{% endraw %} markers, emitting the
  // inner text verbatim).
  expect(body).toContain('<script type="importmap">')
  expect(body).toContain('/_brust/islands/_bootstrap.js')

  // The {% raw %}/{% endraw %} markers themselves must NOT leak into the output.
  expect(body).not.toContain('{% raw %}')
  expect(body).not.toContain('{% endraw %}')
})

test('GET /_test/native/Alice — no-island native route unchanged (no bootstrap)', async () => {
  // Regression: the existing no-island native path must stay byte-identical —
  // no importmap, no bootstrap script, no island markers.
  const res = await fetch(`${BASE_URL}/_test/native/Alice`)
  expect(res.status).toBe(200)
  const body = await res.text()
  expect(body).toContain('<h1>Hello, Alice</h1>')
  expect(body).not.toContain('/_brust/islands/_bootstrap.js')
  expect(body).not.toContain('<script type="importmap">')
  expect(body).not.toContain('data-brust-island')
})

test('GET /_test/native-inline — auto-injected x-data served + directive chunk 200', async () => {
  // The native page inlines <BehaviorBadge native/>. BehaviorBadge has
  // `export const behavior` and NO literal x-data, so the compiler auto-injects
  // x-data="behaviorBadge_<8hex>" onto its root. The injected name is path-hashed
  // against the BUILD cwd (FIXTURE_DIR — the build above ran with cwd: FIXTURE_DIR).
  const name = directiveName(resolve(FIXTURE_DIR, 'components/BehaviorBadge.tsx'), FIXTURE_DIR)
  expect(name).toMatch(/^behaviorBadge_[0-9a-f]{8}$/)

  const res = await fetch(`${BASE_URL}/_test/native-inline`)
  expect(res.status).toBe(200)
  const body = await res.text()

  // 1) The served HTML carries the auto-injected x-data on the (un-annotated)
  //    BehaviorBadge root element.
  expect(
    body.includes(`x-data="${name}"`),
    `Expected served HTML to contain auto-injected x-data="${name}".\nbody:\n${body}`,
  ).toBe(true)

  // 2) F4 single-name contract: the directive chunk the runtime fetches for that
  //    x-data name responds 200 (a name mismatch would 404 here).
  const chunk = await fetch(`${BASE_URL}/_brust/islands/${name}.directive.js`)
  expect(
    chunk.status,
    `Expected /_brust/islands/${name}.directive.js to be 200 (F4: injected x-data must match a served chunk), got ${chunk.status}.`,
  ).toBe(200)
  expect(chunk.headers.get('content-type') ?? '').toContain('javascript')
})
