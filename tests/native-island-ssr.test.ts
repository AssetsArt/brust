import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { spawn, spawnSync } from 'bun'

/** Sub-project J / native SSR islands E2E (T10) — proves the full `native: true`
 * + SERVER-RENDERED <Island ... ssr> pipeline end-to-end, at the running-server
 * level:
 *
 *   NativeSsrIslandPage.tsx (<Island component={Counter} props={count} ssr />)
 *     → jsx-rustc compile → .brust/jinja/NativeSsrIslandPage.jinja
 *         (mount with NO data-brust-csr + `{{ island_0_html | safe }}`
 *          placeholder INSIDE the mount div + island_0_props placeholder —
 *          instance-based keys, source-order instance index)
 *     → T6 reconcile bakes {% raw %}…{% endraw %} importmap+bootstrap
 *     → manifest entry carries ssr:true + the absolute sourcePath of Counter.tsx
 *     → at request time, T9's resolveIslandContext imports Counter's SOURCE .tsx
 *        by absolute path and renderToStrings it server-side, filling
 *        island_0_html with the INITIAL markup (initial useState = start)
 *     → served HTML = static shell + mount whose innerHTML is Counter's SSR
 *        markup + literal bootstrap
 *
 * This is the real-server gating-Q1 proof: a 200 here means the WORKER (not just
 * a unit test) successfully import()ed Counter.tsx source and renderToString'd a
 * real component. A 500 would mean ssr module resolution doesn't work in the
 * running server — see ESCALATE in the task.
 *
 * Browser hydration smoke (real hydrateRoot no-mismatch verification) is OUT OF
 * SCOPE here — this repo has no Playwright/puppeteer infra; that is a documented
 * follow-up. The byte-identity of _html vs the roundtripped _props is unit-tested
 * in runtime/islands/native-render.test.ts.
 *
 * Mirrors tests/native-island.test.ts's boot harness (cargo build jsx-rustc →
 * brust build → spawn → waitForReady → SIGINT), on a different port (3803) to
 * avoid clashing with 3802 (T8) / 3801 (jinja-route).
 */

const REPO_ROOT = resolve(import.meta.dir, '..')
const FIXTURE_DIR = resolve(REPO_ROOT, 'tests/fixtures/app')
const BASE_URL = 'http://127.0.0.1:3803'

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
  // Pre-flight 1: build jsx-rustc binary (the build CLI invokes
  // target/{release,debug}/jsx-rustc; without it, emitNativeTemplates throws).
  const buildRustc = spawnSync({
    cmd: ['cargo', 'build', '-p', 'jsx-rust-compiler', '--bin', 'jsx-rustc'],
    cwd: REPO_ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (buildRustc.exitCode !== 0) {
    throw new Error(
      `cargo build -p jsx-rust-compiler --bin jsx-rustc failed (exit ${buildRustc.exitCode})`,
    )
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

  // Sanity-check the build pass: the native-ssr-island template + its islands
  // manifest must exist, the manifest entry must be ssr:true, and the baked
  // .jinja must carry both the {% raw %} block AND the _html placeholder.
  const jinjaPath = resolve(FIXTURE_DIR, '.brust/jinja/NativeSsrIslandPage.jinja')
  const islandsJsonPath = resolve(FIXTURE_DIR, '.brust/jinja/NativeSsrIslandPage.islands.json')
  const manifestPath = resolve(FIXTURE_DIR, '.brust/jinja/_manifest.json')
  expect(existsSync(jinjaPath)).toBe(true)
  expect(existsSync(islandsJsonPath)).toBe(true)
  expect(existsSync(manifestPath)).toBe(true)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  expect(manifest.templates).toContain('NativeSsrIslandPage')
  const islandsManifest = JSON.parse(readFileSync(islandsJsonPath, 'utf8'))
  // New component-addressed shape: each entry is
  // {component, instance, propsPath, ssr, hydrate, sourcePath} — addressed by
  // `component` (NOT the old `id`) + source-order `instance`.
  const ssrEntry = islandsManifest.find((e: any) => e.component === 'Counter')
  expect(ssrEntry).toBeDefined()
  expect(ssrEntry.instance).toBe(0)
  expect(ssrEntry.ssr).toBe(true)
  expect(ssrEntry.propsPath).toBe('count')
  expect(typeof ssrEntry.hydrate).toBe('string')
  expect(ssrEntry.sourcePath).toContain('Counter')
  const jinjaSrc = readFileSync(jinjaPath, 'utf8')
  expect(jinjaSrc).toContain('{% raw %}')
  // Instance-based context key (single instance → instance 0), NOT the old
  // component-named `island_Counter_html`.
  expect(jinjaSrc).toContain('island_0_html')

  // Two-instance page (acceptance S3): ONE page, TWO <Island component={Counter}>
  // reusing the SAME Counter — instance 0 client-only, instance 1 ssr, distinct
  // props paths. The build must:
  //   - emit a manifest with EXACTLY 2 entries (both component "Counter",
  //     instances 0 and 1, distinct propsPaths, one ssr:false one ssr:true), and
  //   - dedup to ONE shared Counter.js chunk (NOT Counter-1.js / two files).
  // If the build emits two chunks instead of one, that is a DETERMINISTIC
  // component-addressed-islands (T1-T5) failure to ESCALATE, not a fixture bug.
  const twoJinjaPath = resolve(FIXTURE_DIR, '.brust/jinja/NativeTwoIslandPage.jinja')
  const twoIslandsJsonPath = resolve(FIXTURE_DIR, '.brust/jinja/NativeTwoIslandPage.islands.json')
  expect(existsSync(twoJinjaPath)).toBe(true)
  expect(existsSync(twoIslandsJsonPath)).toBe(true)
  expect(manifest.templates).toContain('NativeTwoIslandPage')
  const twoManifest = JSON.parse(readFileSync(twoIslandsJsonPath, 'utf8'))
  expect(twoManifest).toHaveLength(2)
  // Both entries are the SAME component, distinct source-order instances.
  expect(twoManifest.every((e: any) => e.component === 'Counter')).toBe(true)
  expect(twoManifest.map((e: any) => e.instance).sort()).toEqual([0, 1])
  // Instance 0 = client-only (ssr:false, propsPath "first"); instance 1 = ssr
  // (ssr:true, propsPath "second"). Distinct props paths.
  const inst0 = twoManifest.find((e: any) => e.instance === 0)
  const inst1 = twoManifest.find((e: any) => e.instance === 1)
  expect(inst0.ssr).toBe(false)
  expect(inst0.propsPath).toBe('first')
  expect(inst1.ssr).toBe(true)
  expect(inst1.propsPath).toBe('second')
  expect(inst0.propsPath).not.toBe(inst1.propsPath)
  // Both instances resolve to the SAME source file (same Counter reused).
  expect(inst0.sourcePath).toBe(inst1.sourcePath)
  // Chunk dedup: EXACTLY one Counter*.js file in the islands output dir.
  const islandsOutDir = resolve(FIXTURE_DIR, '.brust/islands')
  const counterChunks = readdirSync(islandsOutDir).filter((f) => /^Counter.*\.js$/.test(f))
  expect(counterChunks).toEqual(['Counter.js'])
  // The two-island jinja carries BOTH instances' context keys.
  const twoJinjaSrc = readFileSync(twoJinjaPath, 'utf8')
  expect(twoJinjaSrc).toContain('island_0_props') // client-only instance
  expect(twoJinjaSrc).toContain('island_1_html') // ssr instance

  // SSR-component build sanity (NativeSsrComp = <NativeLayout> wrapping an
  // <Island>). The component compiles to a comp_N slot + a generated factory.
  const compJinjaPath = resolve(FIXTURE_DIR, '.brust/jinja/NativeSsrComp.jinja')
  const compJsonPath = resolve(FIXTURE_DIR, '.brust/jinja/NativeSsrComp.components.json')
  const factoryPath = resolve(FIXTURE_DIR, '.brust/jinja/NativeSsrComp.factory.ts')
  expect(existsSync(compJinjaPath)).toBe(true)
  expect(existsSync(compJsonPath)).toBe(true)
  expect(existsSync(factoryPath)).toBe(true)
  expect(manifest.templates).toContain('NativeSsrComp')
  expect(readFileSync(compJinjaPath, 'utf8')).toContain('comp_0_html')
  // Paths in the artifacts must be PROJECT-RELATIVE, never the build machine's
  // absolute path. components.json sourcePath is cwd-relative; the factory's
  // component imports are relative to the factory file (`../../…`).
  const compJson = JSON.parse(readFileSync(compJsonPath, 'utf8'))
  expect(isAbsolute(compJson[0].sourcePath)).toBe(false)
  const factorySrc = readFileSync(factoryPath, 'utf8')
  expect(factorySrc).toMatch(/^import \w+ from "\.\.?\//m) // a relative import line
  expect(factorySrc).not.toMatch(/import \w+ from "\//) // never absolute
  // ISR fields must SURVIVE the compiler → napi → build-CLI-enrich → disk path
  // (the enrich step spreads RawComponentEntry; the fields are emitted by Rust's
  // components_to_json). Without this end-to-end assertion a stale addon or a
  // future explicit-field-copy refactor in native-routes-emit.ts would silently
  // drop isr and ISR caching would never activate for real builds. The fixture's
  // <NativeLayout ... isr={{ key: greeting, revalidate: 60 }}> drives this.
  expect(compJson[0].keyPath).toBe('greeting')
  expect(compJson[0].revalidate).toBe(60)
  // `isr` must NOT leak into the factory expression as a component prop.
  expect(factorySrc).not.toContain('isr')

  // Spawn brust against the fixture (port 3803 to avoid clashing with 3802/3801).
  proc = spawn({
    cmd: ['bun', 'run', resolve(FIXTURE_DIR, 'index.ts')],
    cwd: FIXTURE_DIR,
    env: {
      ...process.env,
      BRUST_PORT: '3803',
      RUST_LOG: 'brust=warn',
    },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  await waitForReady(BASE_URL)
}, 60_000)

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

// S9 — native loader status sentinels (notFound/redirect). These live HERE,
// not in tests/integration.test.ts, because the server must be booted from a
// `brust build` (done in beforeAll) so the NativeProfile jinja template is
// registered — integration.test.ts boots in source mode with no build, so a
// native route 500s there in a clean CI checkout. Both routes REUSE the
// already-compiled NativeProfile template (templateName = Component.name).
test('S9: native loader notFound() → 404 with rendered template', async () => {
  const res = await fetch(`${BASE_URL}/_test/native-notfound/bob`)
  expect(res.status).toBe(404)
  expect(await res.text()).toContain('Hello, bob')
})
test('S9: native loader redirect() → 302 + Location, empty body', async () => {
  const res = await fetch(`${BASE_URL}/_test/native-redirect`, { redirect: 'manual' })
  expect(res.status).toBe(302)
  expect(res.headers.get('location')).toBe('/_test/native/landed')
  expect(await res.text()).toBe('')
})
test('S9: native loader normal return → 200 (no regression)', async () => {
  const res = await fetch(`${BASE_URL}/_test/native/alice`)
  expect(res.status).toBe(200)
})

test('GET /_test/native-island-ssr — SSR island: static shell + server-rendered mount + bootstrap', async () => {
  const res = await fetch(`${BASE_URL}/_test/native-island-ssr`)

  // gating-Q1 real-server proof: a 200 means the worker import()ed Counter.tsx
  // source and renderToString'd it successfully. A 500 here is the ESCALATE case
  // (ssr module resolution broken in the running server).
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('text/html')

  const body = await res.text()

  // Static shell rendered by jinja from the loader's `greeting`.
  expect(body).toContain('<h1>SSR islands</h1>')

  // The island mount: id + the entity-encoded props JSON of { start: 5 }.
  expect(body).toContain('data-brust-island="Counter"')
  expect(body).toContain('data-brust-props="{&quot;start&quot;:5}"')

  // SSR (not client-only): the mount must NOT carry the data-brust-csr marker.
  expect(body).not.toContain('data-brust-csr')

  // The {{ island_0_html | safe }} placeholder must have been RENDERED —
  // neither the placeholder nor the {% raw %}/{% endraw %} markers may leak.
  expect(body).not.toContain('island_0_html')
  expect(body).not.toContain('{{')
  expect(body).not.toContain('{% raw %}')
  expect(body).not.toContain('{% endraw %}')

  // SSR MARKUP IS INSIDE THE MOUNT: extract the Counter mount div's innerHTML
  // and assert Counter's initial server render is there (NOT empty).
  // renderToString(Counter, {start:5}) === a <button data-testid="counter" ...>
  // whose text is "count: 5" (React inserts <!-- --> separators between the
  // dynamic text segments).
  const open = body.indexOf('<div data-brust-island="Counter"')
  expect(open).toBeGreaterThanOrEqual(0)
  const tagEnd = body.indexOf('>', open)
  const close = body.indexOf('</div>', tagEnd)
  expect(close).toBeGreaterThan(tagEnd)
  const innerHtml = body.slice(tagEnd + 1, close)

  // The mount is NOT empty — it has Counter's server-rendered markup.
  expect(innerHtml.length).toBeGreaterThan(0)
  // Representative substrings of Counter's initial render, INSIDE the mount.
  expect(innerHtml).toContain('<button')
  expect(innerHtml).toContain('data-testid="counter"')
  // The initial useState(start=5) value is rendered server-side.
  expect(innerHtml).toContain('count')
  expect(innerHtml).toContain('5')

  // Bootstrap baked by T6 appears literally (importmap + module bootstrap).
  expect(body).toContain('<script type="importmap">')
  expect(body).toContain('/_brust/islands/_bootstrap.js')
})

test('nav: /_brust/page/<native route> returns {html,title} (regression: native SPA nav 500)', async () => {
  // Regression for the SPA-navigation-on-native-routes bug: navigationBranch
  // used to React-render every route via renderToString. A native component
  // destructures the loader fields directly (they become the jinja scope), so
  // under React those props arrive undefined → `.map()` throws → 500
  // "render failed" → the client's non-2xx check forces a full document reload
  // on EVERY internal link. navigationBranch must instead render the native
  // route through minijinja (Rust-side) and return its HTML.
  const res = await fetch(`${BASE_URL}/_brust/page/_test/native-island-ssr`)
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('application/json')

  const json = (await res.json()) as { html: string; title: string }
  expect(typeof json.html).toBe('string')
  expect(typeof json.title).toBe('string')
  // The native page's SSR island (with its server-rendered markup) survives the
  // navigation render — proving the jinja path ran, not a broken React render.
  expect(json.html).toContain('data-brust-island="Counter"')
  expect(json.html).toContain('count')
  expect(json.html).toContain('5')
  // Not the old error envelope.
  expect(json.html).not.toContain('render failed')
})

test('GET /_test/native-two-islands — same Counter twice (client-only + ssr): one chunk, two distinct mounts', async () => {
  // Acceptance S3 real-server proof: ONE page with TWO <Island component={Counter}>
  // reusing the SAME Counter — instance 0 client-only, instance 1 ssr, distinct
  // props paths. A 200 means the worker resolved both instances and SSR-rendered
  // instance 1.
  const res = await fetch(`${BASE_URL}/_test/native-two-islands`)
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('text/html')

  const body = await res.text()
  expect(body).toContain('<h1>Two islands</h1>')

  // Exactly ONE Counter.js chunk is SERVED (not Counter-1.js, not two files) —
  // the served-level half of the dedup proof (build-time half is in beforeAll).
  const chunk = await fetch(`${BASE_URL}/_brust/islands/Counter.js`)
  expect(chunk.status).toBe(200)
  expect(chunk.headers.get('content-type')).toContain('javascript')
  // The disambiguated second-instance chunk must NOT exist.
  const dupChunk = await fetch(`${BASE_URL}/_brust/islands/Counter-1.js`)
  expect(dupChunk.status).toBe(404)

  // Both mounts carry the IDENTICAL component-name marker — they are
  // disambiguated by source order, not by the marker. Collect BOTH <div
  // data-brust-island="Counter" …>…</div> mounts in source order.
  const mountRe = /<div data-brust-island="Counter"[\s\S]*?<\/div>/g
  const mounts = body.match(mountRe) ?? []
  expect(mounts).toHaveLength(2)
  const [m0, m1] = mounts

  // Distinct props (from the two different props paths first={start:1} /
  // second={start:2}), entity-encoded.
  expect(m0).toContain('data-brust-props="{&quot;start&quot;:1}"')
  expect(m1).toContain('data-brust-props="{&quot;start&quot;:2}"')

  // Instance 0 = client-only: empty data-brust-csr mount (nothing between
  // `>` and `</div>`).
  expect(m0).toContain('data-brust-csr></div>')
  expect(m0).not.toContain('<button')

  // Instance 1 = ssr: NO csr marker, and the server-rendered Counter <button>
  // (initial useState(start=2) → "count: 2") is INSIDE the mount.
  expect(m1).not.toContain('data-brust-csr')
  expect(m1).toContain('<button')
  expect(m1).toContain('data-testid="counter"')
  expect(m1).toContain('count')
  expect(m1).toContain('2')

  // No instance-keyed placeholder or {% raw %} markers leak into the output.
  expect(body).not.toContain('island_0_html')
  expect(body).not.toContain('island_1_html')
  expect(body).not.toContain('{% raw %}')
  expect(body).not.toContain('{% endraw %}')

  // Bootstrap baked once for the page.
  expect(body).toContain('<script type="importmap">')
  expect(body).toContain('/_brust/islands/_bootstrap.js')
})

test('GET /native-ssr-comp — SSR component renders its shell server-side', async () => {
  // <NativeLayout title={greeting}> is a non-Island capitalized component:
  // it renders via the generated factory's renderToString. A 200 with the
  // layout chrome proves the worker `await import()`ed the factory and its
  // RELATIVE component imports resolved at runtime (the whole point of the
  // project-relative path change).
  const res = await fetch(`${BASE_URL}/native-ssr-comp`)
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('text/html')

  const body = await res.text()
  // NativeLayout's shell, rendered server-side from the loader's greeting.
  expect(body).toContain('<header>')
  expect(body).toContain('SSR component test')
  expect(body).toContain('SSR component content')
  // NativeLayout is an SSR component, NOT an island — no marker for it.
  expect(body).not.toContain('data-brust-island="NativeLayout"')
})

test('GET /native-ssr-comp — Island nested in the SSR component still hydrates', async () => {
  // The <Island component={Counter}> lives inside <NativeLayout>'s children.
  // It renders inside the factory's renderToString (Island.tsx React-path),
  // producing a hydration marker + props attribute, and the importmap+bootstrap
  // is baked into the jinja so the client can boot it.
  const res = await fetch(`${BASE_URL}/native-ssr-comp`)
  const body = await res.text()

  expect(body).toContain('data-brust-island="Counter"')
  expect(body).toContain('data-brust-props=')
  // Bootstrap must be present (injected because the SSR component uses an island)
  // — otherwise the marker ships but never hydrates.
  expect(body).toContain('<script type="importmap">')
  expect(body).toContain('/_brust/islands/_bootstrap.js')
})
