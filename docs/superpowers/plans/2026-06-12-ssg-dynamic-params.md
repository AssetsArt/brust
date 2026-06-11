# SSG Dynamic Params Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `brust build --ssg` prerenders dynamic-param routes from `ssg.params()` (Phase A) and, opt-in, serves non-prerendered paths via a client-loader takeover on static hosts (Phase B).

**Architecture:** Spec at `docs/superpowers/specs/2026-06-12-ssg-dynamic-params-design.md` (READ IT FIRST — it is the contract). Phase A is pure build-time TS in `runtime/cli/`. Phase B adds a worker-TS sentinel render, a fallback-chunk build, static-export emission (manifest + 404.html), and a browser takeover runtime. ZERO Rust changes.

**Tech stack:** Bun, TypeScript, bun:test (+ happy-dom for browser-unit), biome.

**Verification gates (run after EVERY task):**
```bash
bunx biome format --write <changed files> && bun run ci
bun test runtime/        # 662+ pass expected, 0 fail
```
e2e gates where a task says so: `bun test runtime/cli/ssg.test.ts` (slow, builds fixture), `bun test tests/integration.test.ts`.

**Commit discipline:** one commit per task, message given in the task.

---

## Phase A — `ssg.params()` expansion

### Task A1: `RouteSsgConfig` type

**Files:** Modify `runtime/routes.ts` (~line 300 `Route` interface, after `cache?:` field)

- [ ] **Step 1:** Add the type + field (full `RouteSsgConfig` ships now; `fallback`/`placeholder` are Phase-B-inert, documented as such):

```ts
/** SSG config — read ONLY by `brust build --ssg`. Live server / dev ignore it.
 * See docs/superpowers/specs/2026-06-12-ssg-dynamic-params-design.md. */
export interface RouteSsgConfig {
  /** generateStaticParams: concrete param records to prerender. Each record
   * must cover every `{name}` in the route's full path with a non-empty
   * string. Sync or async. Values are URL-encoded into the crawl path. */
  params?: () => Array<Record<string, string>> | Promise<Array<Record<string, string>>>
  /** What non-prerendered paths do on a static host. 'none' (default) = skip
   * → host 404 (today's behavior). 'client' = client-loader takeover
   * (Phase B; requires `export const clientLoader` in the leaf component
   * file, leaf must be a DEFAULT import in routes.tsx, React routes only). */
  fallback?: 'none' | 'client'
  /** Server-rendered loading UI baked into the fallback shell (Phase B).
   * Renders in the leaf position with NO data. */
  placeholder?: ComponentType
}
```
and in `Route`:
```ts
  /** Opt-in SSG behavior for dynamic-param routes (`/blog/{slug}`). Only
   * consulted by `brust build --ssg`. */
  ssg?: RouteSsgConfig
```

- [ ] **Step 2:** `bun run ci` + `bun test runtime/routes.test.ts` → green (type-only change).
- [ ] **Step 3:** Commit `feat(ssg): RouteSsgConfig type on Route`.

### Task A2: `expandDynamicRoutes` (TDD)

**Files:** Modify `runtime/cli/ssg.ts`, `runtime/cli/ssg.test.ts`

- [ ] **Step 1:** Write failing unit tests in `ssg.test.ts` (top section, next to the existing pure `collectStaticPaths` tests; reuse/extend the local `route()` helper so chain leaves can carry `ssg`/`native`):

```ts
// ----- expandDynamicRoutes (pure-ish: calls user params fns) -----
const ssgRoute = (
  fullPath: string,
  ssg?: Record<string, unknown>,
  leafExtra: Record<string, unknown> = {},
): FlatRouteLike => ({ fullPath, chain: [{ ...(ssg ? { ssg } : {}), ...leafExtra }] }) as FlatRouteLike

test('expandDynamicRoutes appends concrete entries; pattern stays once in place', async () => {
  const base = [ssgRoute('/blog/{slug}', { params: () => [{ slug: 'a' }, { slug: 'b' }] })]
  const out = await expandDynamicRoutes(base)
  expect(out.map((r) => r.fullPath)).toEqual(['/blog/{slug}', '/blog/a', '/blog/b'])
  expect(out[1]!.chain).toBe(base[0]!.chain) // same chain reference
})

test('expansion URL-encodes values; multi-param patterns substitute every segment', async () => {
  const out = await expandDynamicRoutes([
    ssgRoute('/d/{a}/x/{b}', { params: () => [{ a: 'sa wad-dee', b: 'k/ก' }] }),
  ])
  expect(out[1]!.fullPath).toBe('/d/sa%20wad-dee/x/k%2F%E0%B8%81')
})

test('async params() supported; duplicates deduped', async () => {
  const out = await expandDynamicRoutes([
    ssgRoute('/p/{id}', { params: async () => [{ id: '1' }, { id: '1' }] }),
  ])
  expect(out.map((r) => r.fullPath)).toEqual(['/p/{id}', '/p/1'])
})

test('validation: missing key / empty value / non-array / params throw → Error with pattern', async () => {
  await expect(
    expandDynamicRoutes([ssgRoute('/b/{slug}', { params: () => [{ nope: 'x' }] })]),
  ).rejects.toThrow(/\/b\/\{slug\}.*record #1.*'slug'/)
  await expect(
    expandDynamicRoutes([ssgRoute('/b/{slug}', { params: () => [{ slug: '' }] })]),
  ).rejects.toThrow(/\/b\/\{slug\}/)
  await expect(
    expandDynamicRoutes([ssgRoute('/b/{slug}', { params: () => 'nope' as never })]),
  ).rejects.toThrow(/\/b\/\{slug\}.*array/)  
  await expect(
    expandDynamicRoutes([ssgRoute('/b/{slug}', { params: () => { throw new Error('db down') } })]),
  ).rejects.toThrow(/\/b\/\{slug\}.*db down/)
})

test('validation: sentinel value rejected; ssg on non-dynamic path rejected; native+fallback:client rejected', async () => {
  await expect(
    expandDynamicRoutes([ssgRoute('/b/{slug}', { params: () => [{ slug: '__brust_fallback__' }] })]),
  ).rejects.toThrow(/__brust_fallback__/)
  await expect(
    expandDynamicRoutes([ssgRoute('/static-page', { params: () => [] })]),
  ).rejects.toThrow(/static-page.*no \{param\}/)
  await expect(
    expandDynamicRoutes([ssgRoute('/n/{x}', { fallback: 'client' }, { native: true })]),
  ).rejects.toThrow(/native/)
})

test('routes without ssg pass through untouched (and dynamic ones stay skippable)', async () => {
  const base = [ssgRoute('/'), ssgRoute('/blog/{slug}')]
  const out = await expandDynamicRoutes(base)
  expect(out).toEqual(base)
})
```

- [ ] **Step 2:** Run → FAIL (`expandDynamicRoutes` not exported).
- [ ] **Step 3:** Implement in `ssg.ts`:

```ts
/** Reserved sentinel param value (Phase B fallback shell crawl). */
export const SSG_FALLBACK_SENTINEL = '__brust_fallback__'

/** Structural view of the leaf's ssg config (mirrors RouteSsgConfig). */
export interface RouteSsgLike {
  params?: () => Array<Record<string, string>> | Promise<Array<Record<string, string>>>
  fallback?: 'none' | 'client'
}
type SsgChainNode = { sse?: unknown; websocket?: unknown; native?: unknown; ssg?: RouteSsgLike }

const PARAM_RE = /\{([^/}]+)\}/g
function paramNames(fullPath: string): string[] {
  return [...fullPath.matchAll(PARAM_RE)].map((m) => m[1]!)
}

/** Expand `ssg.params()` routes into concrete prerenderable paths. The
 * pattern route stays in its ORIGINAL list position (never re-appended);
 * concrete entries are appended sharing the same chain reference. Throws on
 * any validation error — build must exit 1, never a silent partial export. */
export async function expandDynamicRoutes(flatRoutes: FlatRouteLike[]): Promise<FlatRouteLike[]> {
  const out = [...flatRoutes]
  for (const route of flatRoutes) {
    const leaf = route.chain[route.chain.length - 1] as SsgChainNode | undefined
    const ssg = leaf?.ssg
    if (!ssg) continue
    const names = paramNames(route.fullPath)
    if (names.length === 0) {
      throw new Error(`ssg config on "${route.fullPath}": route has no {param} segment — remove the dead config`)
    }
    if (ssg.fallback === 'client' && leaf?.native) {
      throw new Error(`ssg.fallback 'client' on "${route.fullPath}": native (jinja) routes cannot client-render — use the island-fetch pattern instead`)
    }
    if (!ssg.params) continue // fallback-only config is legal (Phase B)
    let records: Array<Record<string, string>>
    try {
      records = await ssg.params()
    } catch (err) {
      throw new Error(`ssg.params for "${route.fullPath}" threw: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!Array.isArray(records)) {
      throw new Error(`ssg.params for "${route.fullPath}": expected an array of records`)
    }
    const seen = new Set<string>()
    records.forEach((record, i) => {
      let concrete = route.fullPath
      for (const name of names) {
        const v = record?.[name]
        if (typeof v !== 'string' || v === '') {
          throw new Error(`ssg.params for "${route.fullPath}": record #${i + 1} missing non-empty '${name}'`)
        }
        if (v === SSG_FALLBACK_SENTINEL) {
          throw new Error(`ssg.params for "${route.fullPath}": record #${i + 1} uses the reserved value ${SSG_FALLBACK_SENTINEL}`)
        }
        concrete = concrete.replace(`{${name}}`, encodeURIComponent(v))
      }
      if (seen.has(concrete)) return
      seen.add(concrete)
      out.push({ fullPath: concrete, chain: route.chain })
    })
  }
  return out
}
```

- [ ] **Step 4:** Run the new tests + full `bun test runtime/cli/ssg.test.ts` (unit section is fast; the exportStatic section will also run — that's fine) → PASS.
- [ ] **Step 5:** Commit `feat(ssg): expandDynamicRoutes — params() expansion + validation`.

### Task A3: decoded outFile paths (TDD)

Static hosts DECODE the request URL before file lookup, so `/ssg-blog/sa%20wad-dee` must land in the directory `ssg-blog/sa wad-dee/`. Crawl URLs stay encoded (`fullPath`); on-disk paths decode per segment.

**Files:** Modify `runtime/cli/ssg.ts` (`outFileFor`, `navPayloadFileFor`), `runtime/cli/ssg.test.ts`

- [ ] **Step 1:** Failing tests:

```ts
test('outFile decodes percent-encoded segments (static hosts decode before file lookup)', () => {
  const [d] = collectStaticPaths([route('/ssg-blog/sa%20wad-dee')])
  expect(d!.outFile).toBe('ssg-blog/sa wad-dee/index.html')
  expect(navPayloadFileFor('/ssg-blog/sa%20wad-dee')).toBe(
    join('_brust', 'page', 'ssg-blog', 'sa wad-dee', 'index.html'),
  )
})

test('malformed percent sequences fall back to the raw segment', () => {
  const [d] = collectStaticPaths([route('/x/100%25-not%2')])
  expect(d!.outFile).toBe('x/100%-not%2/index.html')
})
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement a `decodeSegment` helper applied per `/`-segment inside `outFileFor` and `navPayloadFileFor`:

```ts
/** Static hosts decode the URL before file lookup, so on-disk names use the
 * DECODED form while crawl URLs keep the encoded fullPath. Per-segment so a
 * decoded '/' (%2F) cannot create directory traversal: decoded separators are
 * re-encoded back. Malformed sequences keep the raw segment. */
function decodeSegment(seg: string): string {
  try {
    return decodeURIComponent(seg).replaceAll('/', '%2F')
  } catch {
    return seg
  }
}
function decodePathForDisk(normalized: string): string {
  return normalized.split('/').map(decodeSegment).join('/')
}
```
then `outFileFor` / `navPayloadFileFor` call `decodePathForDisk(normalized)` before building the file path.

- [ ] **Step 4:** Run `bun test runtime/cli/ssg.test.ts` → PASS (existing un-encoded paths are unchanged by decode).
- [ ] **Step 5:** Commit `feat(ssg): decode percent-encoded segments for on-disk export paths`.

### Task A4: build.ts wiring + fixture + e2e + docs

**Files:** Modify `runtime/cli/build.ts` (step 8, ~line 577), `tests/fixtures/app/routes.tsx`, create `tests/fixtures/app/components/SsgBlogPost.tsx`, `runtime/cli/ssg.test.ts` (exportStatic section), `example/docs/content/markdown-pages.md`

- [ ] **Step 1:** In `build.ts` step 8, replace the `collectStaticPaths(...)` call with:

```ts
const { collectStaticPaths, exportStatic, expandDynamicRoutes } = await import('./ssg.ts')
let expanded: Parameters<typeof collectStaticPaths>[0]
try {
  expanded = await expandDynamicRoutes((loadedRoutes ?? []) as Parameters<typeof collectStaticPaths>[0])
} catch (err) {
  console.error(`[brust build] ssg: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
const expandedCount = expanded.length - (loadedRoutes ?? []).length
const decisions = collectStaticPaths(expanded)
```
and append `expanded ${expandedCount} dynamic page(s)` info to the existing report line when `expandedCount > 0`.

- [ ] **Step 2:** Fixture component `tests/fixtures/app/components/SsgBlogPost.tsx`:

```tsx
export default function SsgBlogPost({ params, data }: { params: { slug: string }; data: { title: string } }) {
  return (
    <>
      <h1>SsgBlogPost</h1>
      <p data-testid="ssg-slug">{params.slug}</p>
      <p data-testid="ssg-title">{data.title}</p>
    </>
  )
}
```
Route in `tests/fixtures/app/routes.tsx` (default import, near the existing `/blog/{slug}`; do NOT touch `/blog/{slug}` — ssg.test.ts hardcodes it as the dynamic-param skip case):

```tsx
{ path: '/ssg-blog/{slug}', Component: SsgBlogPost,
  loader: async ({ params }) => ({ title: `post:${params.slug}` }),
  ssg: { params: () => [{ slug: 'hello' }, { slug: 'sa wad-dee' }] } },
```

- [ ] **Step 3:** e2e additions in `ssg.test.ts`'s exportStatic section — the section builds the fixture via the CLI and boots the dist, so the expansion happens in the CLI build... **NO — exportStatic tests call `collectStaticPaths`/`exportStatic` directly with hand-built decisions.** Add expansion at the test level: build decisions from `expandDynamicRoutes(routes-from-fixture)`? The fixture's routes module imports server deps — instead assert at the CLI level: extend the existing `beforeAll` build? The cleanest e2e: after the existing exportStatic test, add one that crawls the two concrete paths:

```ts
test('expanded ssg.params routes export concrete pages + payloads (decoded dirs)', async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), 'brust-ssg-exp-'))
  try {
    const res = await exportStatic({
      distDir, entryDir: appDir, staticOut: outDir,
      routes: collectStaticPaths(
        await expandDynamicRoutes([
          { fullPath: '/ssg-blog/{slug}', chain: [{ ssg: { params: () => [{ slug: 'hello' }, { slug: 'sa wad-dee' }] } }] } as FlatRouteLike,
        ]),
      ),
    })
    expect(res.written).toContain('ssg-blog/hello/index.html')
    expect(res.written).toContain('ssg-blog/sa wad-dee/index.html')
    expect(res.navWritten).toContain(path.join('_brust', 'page', 'ssg-blog', 'sa wad-dee', 'index.html'))
    const html = await Bun.file(path.join(outDir, 'ssg-blog', 'sa wad-dee', 'index.html')).text()
    expect(html).toContain('post:sa wad-dee') // loader ran with the DECODED param
    expect(res.skipped.map((s) => s.fullPath)).toEqual(['/ssg-blog/{slug}'])
  } finally {
    await rm(outDir, { recursive: true, force: true })
  }
}, 60_000)
```
(NOTE for implementer: the decoded-param assertion exercises Rust's matchit decode — if `params.slug` arrives still-encoded, the loader output will show `sa%20wad-dee`; if so, assert the encoded form instead AND record the discrepancy in the task report — do not silently change other behavior.)

- [ ] **Step 4:** Docs: `example/docs/content/markdown-pages.md` Static-export section — add an `ssg.params` subsection with the blog example (server loader unchanged, 20-latest pattern, path-based pagination note from the spec's non-goals).
- [ ] **Step 5:** Gates: `bun run ci`, `bun test runtime/`, `bun test runtime/cli/ssg.test.ts`, `bun test tests/integration.test.ts` → green.
- [ ] **Step 6:** Commit `feat(ssg): build-time ssg.params expansion + fixture + e2e + docs`.

**BLOCKED fallback:** if the exportStatic-level e2e can't reach expansion cleanly, pivot to a full-CLI e2e (run `brust build --ssg` on the fixture via `$` like `beforeAll` does, assert the static dir) — slower but exercises the real wiring.

---

## Phase B — `fallback: 'client'`

### Task B1: `forceIslands` injection flag (TDD)

**Files:** Modify `runtime/render/stream.ts` (`RenderBranchStreamingArgs` ~line 16, `islandUsedBox.used` read ~line 170), `runtime/render/stream.test.ts`

- [ ] **Step 1:** Failing test (follow stream.test.ts's existing harness for fake napi/view): render an element with NO `<Island>` but `forceIslands: true` → the assembled HTML contains `/_brust/islands/_bootstrap.js`; with neither → does not.
- [ ] **Step 2:** Implement: add `forceIslands?: boolean` to the args interface (JSDoc: "inject importmap+bootstrap even when no <Island> rendered — SSG fallback shells must boot the takeover runtime") and change the gate to `const islandsUsed = islandUsedBox.used || (args.forceIslands ?? false)`.
- [ ] **Step 3:** `bun test runtime/render/` → PASS. Commit `feat(render): forceIslands injection flag for fallback shells`.

### Task B2: sentinel shell render in the worker (TDD via integration)

**Files:** Modify `runtime/routes.ts` (chain assembly ~line 1518 `composeElement`-style function + its TWO callers: the render branch ~1134 and `navigationBranch` ~1242), `tests/fixtures/app/routes.tsx` + create `tests/fixtures/app/components/SsgFallbackPost.tsx`, `tests/integration.test.ts`

- [ ] **Step 1:** Fixture: `SsgFallbackPost.tsx` —

```tsx
export const clientLoader = async ({ params }: { params: Record<string, string> }) => {
  const resp = await fetch(`/api/ssg-fallback-data/${params.slug}`)
  if (!resp.ok) throw new Error(`data: ${resp.status}`)
  return (await resp.json()) as { title: string }
}

export default function SsgFallbackPost({ params, data }: { params: { slug: string }; data: { title: string } }) {
  return (
    <>
      <h1>SsgFallbackPost</h1>
      <p data-testid="fb-slug">{params.slug}</p>
      <p data-testid="fb-title">{data.title}</p>
    </>
  )
}
```
Route (default import): `{ path: '/ssg-fb/{slug}', Component: SsgFallbackPost, loader: async ({ params }) => ({ title: `srv:${params.slug}` }), ssg: { params: () => [{ slug: 'pre' }], fallback: 'client' } }` plus a tiny JSON api route `/api/ssg-fallback-data/{slug}` returning `{ title: 'client:' + params.slug }` (follow the fixture's existing JSON-route pattern; if none fits, an action/loader-based JSON route is fine).

- [ ] **Step 2:** Failing integration tests (booted fixture, follow the suite's fetch conventions):
  - `GET /ssg-fb/__brust_fallback__` with header `x-brust-ssg: 1` → 200, body contains `data-brust-fallback-root`, `data-brust-fallback="/ssg-fb/{slug}"`, `_bootstrap.js`, and does NOT contain `srv:__brust_fallback__` (leaf loader skipped).
  - same URL WITHOUT the header → renders normally (`srv:__brust_fallback__` present, no fallback marker).
  - `GET /_brust/page/ssg-fb/__brust_fallback__` with header → JSON payload whose `html` contains the marker.
  - `GET /ssg-fb/pre` (no header) → normal render `srv:pre`.
- [ ] **Step 3:** Implement in `routes.ts`: a helper

```ts
const SSG_FALLBACK_SENTINEL = '__brust_fallback__'
function ssgFallbackShellWanted(flat: FlatRoute, call: { params: Record<string, string>; req: BrustRequest }): boolean {
  const leaf = flat.chain[flat.chain.length - 1] as Route & { ssg?: { fallback?: string; placeholder?: ComponentType } }
  if (leaf?.ssg?.fallback !== 'client') return false
  const keys = Object.keys(call.params)
  if (keys.length === 0) return false
  if (!keys.every((k) => call.params[k] === SSG_FALLBACK_SENTINEL)) return false
  // header read: adapt to BrustRequest's actual header surface (verify!)
  return call.req.headers.get?.('x-brust-ssg') === '1' || (call.req.headers as unknown as Record<string, string>)['x-brust-ssg'] === '1'
}
```
In the chain assembly: when wanted, skip the LEAF loader and substitute the leaf Component with a wrapper rendering `createElement('div', { 'data-brust-fallback-root': '', 'data-brust-fallback': flat.fullPath }, leaf.ssg?.placeholder ? createElement(leaf.ssg.placeholder) : null)`. Thread `forceIslands: true` into `renderBranchStreaming` (render branch) and ensure `navigationBranch`'s payload path also carries the marker (it extracts `<main>` from the rendered doc — verify the marker lands inside `<main>`).
- [ ] **Step 4:** `bun test tests/integration.test.ts` → PASS (incl. all pre-existing). `bun test runtime/` green. Commit `feat(ssg): sentinel fallback-shell render (header-gated, worker TS)`.

**BLOCKED fallback:** if `BrustRequest` doesn't expose raw request headers in the worker, ESCALATE with the actual shape found — do NOT add a Rust change unilaterally.

### Task B3: fallback chunk build (TDD)

**Files:** Modify `runtime/cli/build.ts` (new step between islands build and SSG), `runtime/cli/ssg.ts` (helpers), `runtime/cli/ssg.test.ts`

- [ ] **Step 1:** Failing unit tests for the pure helpers in `ssg.ts`:

```ts
test('fallbackDiskPath sanitizes {param} → __param__', () => {
  expect(fallbackDiskPath('/blog/{slug}')).toBe('blog/__slug__')
  expect(fallbackDiskPath('/d/{a}/x/{b}')).toBe('d/__a__/x/__b__')
})
test('fallbackSentinelPath substitutes every param with the sentinel', () => {
  expect(fallbackSentinelPath('/d/{a}/x/{b}')).toBe('/d/__brust_fallback__/x/__brust_fallback__')
})
test('fallbackEntrySource emits the chunk entry module', () => {
  expect(fallbackEntrySource('/abs/components/Post.tsx')).toBe(
    `import C, { clientLoader } from '/abs/components/Post.tsx'\nexport { C as Component, clientLoader }\n`,
  )
})
```
- [ ] **Step 2:** Implement the three helpers (trivial, exported).
- [ ] **Step 3:** In `build.ts`, after the islands build step: collect `fallback: 'client'` routes from `loadedRoutes` (only under `parsed.ssg`); for each, resolve the leaf Component source via `scanImports(routesFile)` (`runtime/cli/native-routes-emit.ts:864` — default-import map `localName → abs path`; the leaf's identifier comes from `Component.name`, the same minifier-safe capture native routes use). Unresolvable → `console.error` with the route pattern + "leaf Component must be a default import in routes.tsx" + `process.exit(1)`. Read the source file and check `/export\s+(const|async\s+function|function)\s+clientLoader\b/` — missing → exit 1 with message. Write the generated entry to a temp file and bundle via the islands `buildOne` (import it from `runtime/islands/build.ts`; externals = the same 3 react specifiers) into `<outDir>/islands/` with name `Fallback_<ComponentName>_<8hex sha256 of relative source path>.js` (reuse `islandChunkBasename`-style hashing from `runtime/islands/chunk-id.ts` if its signature fits; else inline the same recipe). Return a `pattern → chunk public URL` map for Task B4's manifest.
- [ ] **Step 4:** Unit-test the clientLoader-presence regex + error paths where extractable; the full chunk build is covered by Task B7's e2e. Gates green. Commit `feat(ssg): fallback chunk build (component + clientLoader bundle)`.

### Task B4: static-export fallback emission (manifest + 404.html)

**Files:** Modify `runtime/cli/ssg.ts` (`exportStatic`), `runtime/cli/build.ts` (pass fallback info), `runtime/cli/ssg.test.ts`

- [ ] **Step 1:** Extend `exportStatic` opts with `fallbacks?: Array<{ pattern: string; chunk: string }>`. For each: crawl `GET <fallbackSentinelPath(pattern)>` with header `x-brust-ssg: 1` → write `_brust/fallback/<fallbackDiskPath>/index.html`; crawl `/_brust/page<sentinelPath>` (same header) → validate JSON `html` (same guard as nav payloads) → `_brust/fallback-page/<fallbackDiskPath>/index.html`. Any non-200 → fail the export (same no-partial rule).
- [ ] **Step 2:** Emit `_brust/routes.json`: `{ version: 1, fallbacks: [{ pattern, doc: '/_brust/fallback/<disk>/', payload: '/_brust/fallback-page/<disk>/', chunk }] }` (trailing-slash URLs — directory indexes). No fallbacks → no file.
- [ ] **Step 3:** Emit `404.html` UNLESS `<entryDir>/public/404.html` exists (then `console.warn` listing what the app's own file must do). Generated content (inline, no external deps; manifest JSON embedded):

```html
<!doctype html><html><head><meta charset="utf-8"><title>404</title></head><body>
<p>Not found.</p>
<script>
(function () {
  var MANIFEST = __INLINE_FALLBACKS_JSON__; // [{pattern, doc}]
  function match(pattern, path) {
    var p = pattern.split('/'), u = path.split('/')
    if (p.length !== u.length) return false
    for (var i = 0; i < p.length; i++) {
      if (p[i].charAt(0) === '{') { if (!u[i]) return false }
      else if (p[i] !== u[i]) return false
    }
    return true
  }
  for (var i = 0; i < MANIFEST.length; i++) {
    if (match(MANIFEST[i].pattern, location.pathname)) {
      try { sessionStorage.setItem('brust:fallback-path', location.pathname + location.search) } catch (e) {}
      location.replace(MANIFEST[i].doc)
      return
    }
  }
})()
</script></body></html>
```
- [ ] **Step 4:** Unit tests: manifest shape, 404.html emitted only with fallbacks, public/404.html short-circuit. Gates green. Commit `feat(ssg): fallback shell/payload emission + routes.json manifest + 404.html`.

### Task B5: client takeover runtime (TDD)

**Files:** Create `runtime/islands/fallback.ts`, `runtime/islands/fallback.test.ts`

- [ ] **Step 1:** Failing unit tests (no DOM needed for the matcher; happy-dom for takeover-adjacent pieces is NOT required — takeover itself is covered by B6 unit + Phase-6 browser):

```ts
import { test, expect, beforeEach, mock, afterAll } from 'bun:test'
import { matchFallback, loadFallbackManifest, __resetFallbackForTest } from './fallback.ts'

const realFetch = globalThis.fetch
afterAll(() => { globalThis.fetch = realFetch })
beforeEach(() => __resetFallbackForTest())

test('matchFallback captures decoded params; rejects length/literal mismatches', () => {
  expect(matchFallback('/blog/{slug}', '/blog/sa%20wad-dee')).toEqual({ slug: 'sa wad-dee' })
  expect(matchFallback('/d/{a}/x/{b}', '/d/1/x/2')).toEqual({ a: '1', b: '2' })
  expect(matchFallback('/blog/{slug}', '/blog')).toBeNull()
  expect(matchFallback('/blog/{slug}', '/news/x')).toBeNull()
  expect(matchFallback('/blog/{slug}', '/blog/a/b')).toBeNull()
  expect(matchFallback('/blog/{slug}', '/blog/')).toBeNull() // empty capture
})

test('loadFallbackManifest memoizes; 404/invalid → empty list', async () => {
  let calls = 0
  ;(globalThis as Record<string, unknown>).fetch = mock(async () => { calls++; return { ok: false, status: 404 } })
  expect(await loadFallbackManifest()).toEqual([])
  expect(await loadFallbackManifest()).toEqual([])
  expect(calls).toBe(1)
})
```
- [ ] **Step 2:** Implement `fallback.ts`: `matchFallback` (segment matcher, `decodeURIComponent` captures with try/catch→raw), `loadFallbackManifest` (memoized fetch of `/_brust/routes.json`, validates `Array.isArray(j.fallbacks)`), `takeover(container)` per spec (own `fallbackRoots` WeakMap; `unmountFallbackRootsIn(root)` export; clientLoader throw → console.error + `data-brust-fallback-error`; `import(chunk)` via variable specifier so the bundler leaves it dynamic), `__resetFallbackForTest`.
- [ ] **Step 3:** PASS + gates. Commit `feat(islands): client fallback runtime (matcher + manifest + takeover)`.

### Task B6: bootstrap wiring (TDD)

**Files:** Modify `runtime/islands/bootstrap.ts`, `runtime/islands/bootstrap.test.ts`

- [ ] **Step 1:** Failing tests (existing happy-dom harness):
  - navigate() to a path whose payload fetch 404s, with `fetch` stubbed so `/_brust/routes.json` returns `{version:1,fallbacks:[{pattern:'/fb/{id}',payload:'/_brust/fallback-page/fb/__id__/',doc:'/_brust/fallback/fb/__id__/',chunk:'/mock-fb-chunk.js'}]}` and the payload URL returns `{html:'<div data-brust-fallback-root data-brust-fallback="/fb/{id}"></div>',title:'FB'}`, with `mock.module('/mock-fb-chunk.js', …)` exporting `{ Component: () => null, clientLoader: async () => ({}) }` → expect: `<main>` contains the fallback root, nav phase ends `'success'`, NO `location.href` fallback (stub `location.href` setter or assert path committed).
  - navigate() 404 with NO manifest (routes.json 404) → falls back to full reload (existing behavior — assert via the same location capture the existing failure test uses, or `__navError` fired).
  - `unmountIslandsIn` calls `unmountFallbackRootsIn` (spy via a rendered fallback root).
- [ ] **Step 2:** Implement: `attemptClientFallback(url, ac): Promise<boolean>` in bootstrap.ts (uses fallback.ts exports; on success runs the SAME post-swap sequence as the normal path — scroll save, pushState/replaceState per mode, scrollTo, `currentPageKey` update — then `await takeover(container)` then `__navCommit`). Hook: in `navigate()`'s non-cached fetch path, wrap in try/catch: catch non-Abort errors → `if (await attemptClientFallback(url, ac)) return` → otherwise rethrow. Boot path: in the module-init block, after `__navInit`, if `document.querySelector('[data-brust-fallback-root]')` → consume `sessionStorage['brust:fallback-path']` (remove after read) → `history.replaceState({}, '', savedPath)` → `void takeover(el)`. `unmountIslandsIn` → also `unmountFallbackRootsIn(root)`.
- [ ] **Step 3:** PASS + full `bun test runtime/` + gates. Commit `feat(islands): navigate + boot fallback takeover wiring`.

**BLOCKED fallback:** if happy-dom can't express the 404→fallback flow (e.g. dynamic `import()` of the mocked chunk fails inside the module), split: unit-test `attemptClientFallback`'s decision logic with injected fns, and lean on Phase-6 browser verification for the integrated path. Record the split in the report.

### Task B7: e2e + docs

**Files:** `runtime/cli/ssg.test.ts` (full-CLI e2e), `example/docs/content/markdown-pages.md` + `example/docs/content/navigation.md`

- [ ] **Step 1:** e2e: run the REAL CLI `brust build --ssg` on the fixture app (mirror the `beforeAll` `$` pattern; own mkdtemp out-dir; 180s timeout) and assert the static out contains: `ssg-fb/pre/index.html` (prerendered, contains `srv:pre`, NO fallback marker), `_brust/fallback/ssg-fb/__slug__/index.html` (contains marker + `_bootstrap.js`), `_brust/fallback-page/ssg-fb/__slug__/index.html` (valid JSON, html has marker), `_brust/routes.json` (pattern `/ssg-fb/{slug}`, chunk file exists in `_brust/islands/`... NOTE: chunk lands in `<outDir>/islands/` and is copied to `_brust/islands/` by the existing asset copy — assert the copied path), `404.html` (contains `/ssg-fb/{slug}` pattern → wait, patterns with `{}` — assert the manifest JSON embedded).
- [ ] **Step 2:** Docs: navigation.md (fallback takeover note in the static-exports section), markdown-pages.md static-export section: `fallback: 'client'`, clientLoader convention (component file, default import, browser-safe top-level imports), 404.html + host notes, reserved sentinel, limitations (HTTP 404 on direct hits, no req/workerId props, no errorBoundary wrap).
- [ ] **Step 3:** ALL gates: `bun run ci`, `bun test runtime/`, `bun test runtime/cli/ssg.test.ts`, `bun test tests/native-island.test.ts`, `bun test tests/native-island-ssr.test.ts`, `bun test tests/cli-new.test.ts`, `bun test tests/integration.test.ts`. Commit `feat(ssg): fallback e2e + docs`.

---

## Spec coverage check

| Spec section | Task |
|---|---|
| RouteSsgConfig API | A1 |
| expansion + validation (+ sentinel value, native+fallback, dead config) | A2 |
| encoded crawl / decoded disk | A3 |
| build wiring, reporting, fixture, Phase-A e2e, Phase-A docs | A4 |
| forceIslands contract | B1 |
| sentinel shell render (header-gated) | B2 |
| chunk build + source resolution + clientLoader check | B3 |
| fallback emission + manifest + 404.html | B4 |
| matcher/manifest/takeover runtime | B5 |
| navigate hook + boot path + unmount | B6 |
| e2e + docs | B7 |
| browser verification on a real static server | Phase 6 (orchestrator) |
