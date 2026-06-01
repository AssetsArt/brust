# Plan — Treaty Action System Completion

Spec: `docs/superpowers/specs/2026-06-01-treaty-completion-design.md`
Base: `1efbc7a` (branch `feat/actions-treaty-client`)

## Conventions (every task)
- TS lint gate is **biome**: `bunx biome ci <files>` after every `.ts` edit. Do
  NOT run `bunx tsc` (stack-overflows).
- Do NOT `git add -A` (untracked `tools/` is the user's). Stage explicit paths.
- Do NOT edit `crates/` (Rust). The wire already ships `content_type`/`body_text`
  /`body_b64`.
- TDD: write/extend the test first (red), implement (green), run verify, report.
- The orchestrator commits after each task's reviews pass.

## Spec-coverage map
| Spec section | Task |
|---|---|
| Phase A `.head` builder | A1 |
| Phase A e2e (PUT/PATCH/HEAD/query-422) | A2 |
| Phase B server coercion (urlencoded+multipart) | B1 |
| Phase B client multipart send | B2 |
| Phase B e2e (urlencoded + multipart) | B3 |
| Phase C inject-action-prefix + stream both paths + run() wiring | C1 |
| Phase C custom-prefix e2e | C2 |
| Phase D bench re-measure | orchestrator (post-pipeline) |

---

## A1 — `.head` builder

**Edit `runtime/define-actions.ts`** — add to the `ActionsBuilder<Acc>` interface
(after `delete<...>`):
```ts
  head<P extends string, O extends EndpointOptions, R>(
    path: P,
    handler: Handler<BodyOf<O>, Params<P>, QueryOf<O>, R>,
    opts?: O,
  ): ActionsBuilder<Acc & { [K in P]: { HEAD: { input: QueryOf<O>; output: Awaited<R> } } }>
```
And to the runtime builder object (after the `delete(...)` method):
```ts
    head(p: string, h: any, o?: EndpointOptions) {
      add('HEAD', p, h, o)
      return builder
    },
```
No dispatch change (`EndpointDef.method` already has `'HEAD'`; `dispatchAction`
already treats HEAD as bodyless).

**Test** — extend `runtime/action-dispatch.test.ts` (or `define-actions.test.ts`
if it exists; check first). Add:
```ts
test('HEAD endpoint accumulates + dispatches bodyless', async () => {
  const a = defineActions().head('/notes/{id}', ({ params }) => ({ seen: params.id }))
  const res = await dispatchAction(
    { kind: 'action', action_id: '0', content_type: '', params: { id: 'z' },
      req: { method: 'HEAD', ...reqBase } as any },
    table(a),
  )
  expect(res.status).toBe(200)
  expect(JSON.parse(res.body)).toEqual({ seen: 'z' })
})
test('duplicate HEAD path throws', () => {
  expect(() => defineActions().head('/x', () => ({})).head('/x', () => ({}))).toThrow(/duplicate/)
})
```
(Confirm `reqBase`/`table` helpers exist in that file — they do per the MCP work.)

**Verify:**
```
bun test runtime/action-dispatch.test.ts
bunx biome ci runtime/define-actions.ts runtime/action-dispatch.test.ts
```
Expected: pass; biome 0.

---

## A2 — Fixture endpoints + e2e (PUT/PATCH/HEAD/query-422)

**Edit `tests/fixtures/app/actions.ts`** — add endpoints to the chain (keep
existing ones). Use `z` (already imported):
```ts
  .put('/notes/{id}', ({ params, body }) => ({ id: params.id, text: (body as { text: string }).text, updated: true }), {
    body: z.object({ text: z.string() }),
  })
  .patch('/notes/{id}', ({ params, body }) => ({ id: params.id, patched: (body as { text?: string }).text ?? null }), {
    body: z.object({ text: z.string().optional() }),
  })
  .head('/notes/{id}', ({ params }) => ({ id: params.id }))
  .get('/search', ({ query }) => ({ limit: (query as { limit: number }).limit }), {
    query: z.object({ limit: z.coerce.number() }),
  })
```

**Edit `tests/integration.test.ts`** — add tests (use `sharedPort()` for the
stateless ones; they're read-only). Mirror the existing action-test style
(`fetch(http://127.0.0.1:${port}/_brust/action/...)`).
```ts
test('action: PUT /notes/{id} round-trips', async () => {
  const r = await fetch(`http://127.0.0.1:${sharedPort()}/_brust/action/notes/abc`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'hello' }),
  })
  expect(r.status).toBe(200)
  expect(await r.json()).toEqual({ id: 'abc', text: 'hello', updated: true })
})
test('action: PATCH /notes/{id} round-trips', async () => {
  const r = await fetch(`http://127.0.0.1:${sharedPort()}/_brust/action/notes/xy`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'p' }),
  })
  expect(r.status).toBe(200)
  expect(await r.json()).toEqual({ id: 'xy', patched: 'p' })
})
test('action: HEAD /notes/{id} returns 200 (body currently shipped, not stripped)', async () => {
  const r = await fetch(`http://127.0.0.1:${sharedPort()}/_brust/action/notes/h`, { method: 'HEAD' })
  expect(r.status).toBe(200)
  // OQ#1: Rust does not strip the HEAD body. Assert reality; do not assert empty.
})
test('action: GET /search 422 on invalid query', async () => {
  const r = await fetch(`http://127.0.0.1:${sharedPort()}/_brust/action/search?limit=abc`)
  expect(r.status).toBe(422)
})
test('action: GET /search 200 on valid query', async () => {
  const r = await fetch(`http://127.0.0.1:${sharedPort()}/_brust/action/search?limit=5`)
  expect(r.status).toBe(200)
  expect(await r.json()).toEqual({ limit: 5 })
})
```
NOTE: adding fixture endpoints changes the MCP `tools/list` set (new tools
`put_notes_by_id`, `patch_notes_by_id`, `head_notes_by_id`, `get_search`). The
existing `mcp: tools/list returns action-derived tools` test uses `.toContain`,
so it stays green — but VERIFY it still passes after the fixture change.

**Verify:**
```
bun test tests/integration.test.ts
bunx biome ci tests/fixtures/app/actions.ts tests/integration.test.ts
```
Expected: all pass (existing + 5 new). biome 0. If HEAD returns non-200, report
the actual status (do not weaken — investigate; the fixture handler returns a
plain object so 200 is expected).

**BLOCKED fallback (A2):** if `z.coerce.number()` on `?limit=abc` does NOT 422
(coerces to NaN and passes), the query schema needs `z.coerce.number().refine(n
=> !Number.isNaN(n))` or use `z.string().regex(/^\d+$/).transform(Number)`. Pick
whichever makes invalid→422 true and adjust the fixture; keep the test asserting
422.

---

## B1 — Server body coercion (urlencoded + multipart)

**Edit `runtime/routes.ts`** — replace the JSON-only decode block in
`dispatchAction` (~line 1113-1128) with a content-type dispatch. Add a module
helper above `dispatchAction`:
```ts
async function decodeActionBody(
  call: Extract<RouteCall, { kind: 'action' }>,
): Promise<{ ok: true; value: unknown } | { ok: false; status: number; body: string }> {
  const ct = (call.content_type ?? '').toLowerCase()
  // urlencoded → flat object of strings
  if (ct.startsWith('application/x-www-form-urlencoded')) {
    return { ok: true, value: Object.fromEntries(new URLSearchParams(call.body_text ?? '')) }
  }
  // multipart → object of strings + File entries (via Bun's Response.formData)
  if (ct.startsWith('multipart/form-data')) {
    try {
      const bytes = Buffer.from(call.body_b64 ?? '', 'base64')
      const fd = await new Response(bytes, { headers: { 'content-type': call.content_type } }).formData()
      return { ok: true, value: Object.fromEntries(fd.entries()) }
    } catch (err) {
      return {
        ok: false, status: 400,
        body: JSON.stringify({ error: { message: `invalid multipart body: ${(err as Error).message}` } }),
      }
    }
  }
  // default: JSON
  try {
    return {
      ok: true,
      value: call.body_text != null && call.body_text !== '' ? JSON.parse(call.body_text) : undefined,
    }
  } catch (err) {
    return {
      ok: false, status: 400,
      body: JSON.stringify({ error: { message: `invalid JSON body: ${(err as Error).message}` } }),
    }
  }
}
```
Then in `dispatchAction`, replace the JSON-only block with:
```ts
  let rawBody: unknown
  if (def.method !== 'GET' && def.method !== 'HEAD') {
    const decoded = await decodeActionBody(call)
    if (!decoded.ok) {
      return { status: decoded.status, body: decoded.body, contentType: 'application/json; charset=utf-8' }
    }
    rawBody = decoded.value
  }
```
(The downstream `validate(def.body, rawBody)` → 422 path is unchanged.)

**Test** — extend `runtime/action-dispatch.test.ts`:
```ts
import { z } from 'zod'  // already imported in that file

test('urlencoded body coerces to object and validates', async () => {
  const a = defineActions().post('/f', ({ body }) => body, { body: z.object({ a: z.string(), b: z.string() }) })
  const res = await dispatchAction(
    { kind: 'action', action_id: '0', content_type: 'application/x-www-form-urlencoded',
      params: {}, body_text: 'a=1&b=hi', req: { method: 'POST', ...reqBase } as any },
    table(a),
  )
  expect(res.status).toBe(200)
  expect(JSON.parse(res.body)).toEqual({ a: '1', b: 'hi' })
})

test('multipart body coerces (text fields + File) and validates', async () => {
  const fd = new FormData()
  fd.append('name', 'alice')
  fd.append('file', new File(['hi'], 'h.txt', { type: 'text/plain' }))
  const wire = new Request('http://x', { method: 'POST', body: fd })
  const ct = wire.headers.get('content-type')!
  const b64 = Buffer.from(new Uint8Array(await wire.arrayBuffer())).toString('base64')
  const a = defineActions().post('/u', ({ body }) => ({ name: (body as any).name, fileName: (body as any).file?.name }), {
    body: z.object({ name: z.string(), file: z.instanceof(File) }),
  })
  const res = await dispatchAction(
    { kind: 'action', action_id: '0', content_type: ct, params: {}, body_b64: b64, req: { method: 'POST', ...reqBase } as any },
    table(a),
  )
  expect(res.status).toBe(200)
  expect(JSON.parse(res.body)).toEqual({ name: 'alice', fileName: 'h.txt' })
})

test('malformed multipart → 400', async () => {
  const a = defineActions().post('/u', ({ body }) => body)
  const res = await dispatchAction(
    { kind: 'action', action_id: '0', content_type: 'multipart/form-data; boundary=----x',
      params: {}, body_b64: Buffer.from('garbage not multipart').toString('base64'),
      req: { method: 'POST', ...reqBase } as any },
    table(a),
  )
  expect(res.status).toBe(400)
})
```
NOTE: if `Response.formData()` is lenient and does NOT throw on the "garbage"
input (returns empty FormData → `{}`), the malformed test will see 200, not 400.
In that case change the malformed assertion to expect 200 with `{}` and add a
comment that Bun's parser is lenient — do NOT fake a 400. (Empirically the
orchestrator confirmed valid round-trips; leniency on garbage is acceptable.)

**Verify:**
```
bun test runtime/action-dispatch.test.ts
bunx biome ci runtime/routes.ts runtime/action-dispatch.test.ts
```
Expected: pass; biome 0.

---

## B2 — Client multipart send

**Edit `runtime/treaty.ts`** — in the method terminal, replace the JSON body
block (lines 50-53) with File/Blob detection. Add a top-level helper:
```ts
function hasFilePart(b: unknown): boolean {
  if (b instanceof FormData || b instanceof Blob) return true
  if (b && typeof b === 'object') return Object.values(b as Record<string, unknown>).some((v) => v instanceof Blob)
  return false
}
function toFormData(b: unknown): FormData {
  if (b instanceof FormData) return b
  const fd = new FormData()
  for (const [k, v] of Object.entries(b as Record<string, unknown>)) {
    if (v instanceof Blob) fd.append(k, v)
    else if (v !== null && typeof v === 'object') fd.append(k, JSON.stringify(v))
    else fd.append(k, String(v))
  }
  return fd
}
```
Replace the body-setting block:
```ts
            if (!isBodyless && body !== undefined) {
              if (hasFilePart(body)) {
                init.body = toFormData(body)
                // Let fetch set the multipart boundary; a stale content-type
                // (e.g. from caller headers) would break it.
                delete (init.headers as Record<string, string>)['content-type']
              } else {
                init.body = JSON.stringify(body)
                ;(init.headers as Record<string, string>)['content-type'] = 'application/json'
              }
            }
```

**Test** — `runtime/treaty.test.ts` (extend; confirm it exists). Add with an
injected `fetch` capturing `init`:
```ts
test('body with a Blob sends FormData, no json content-type', async () => {
  let captured: any
  const api = client<any>({ fetch: (async (_u: string, init: any) => { captured = init; return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }) }) as any })
  await api.upload.post({ name: 'x', file: new Blob(['hi'], { type: 'text/plain' }) })
  expect(captured.body instanceof FormData).toBe(true)
  expect((captured.headers as Record<string, string>)['content-type']).toBeUndefined()
})
test('FormData passed directly is sent as-is', async () => {
  let captured: any
  const api = client<any>({ fetch: (async (_u: string, init: any) => { captured = init; return new Response('{}', { status: 200 }) }) as any })
  const fd = new FormData(); fd.append('a', '1')
  await api.upload.post(fd)
  expect(captured.body).toBe(fd)
})
test('plain object still sends JSON (regression)', async () => {
  let captured: any
  const api = client<any>({ fetch: (async (_u: string, init: any) => { captured = init; return new Response('{}', { status: 200 }) }) as any })
  await api.notes.post({ text: 'hi' })
  expect(captured.body).toBe(JSON.stringify({ text: 'hi' }))
  expect((captured.headers as Record<string, string>)['content-type']).toBe('application/json')
})
```
(Match the existing treaty.test.ts client-construction style; adapt the `client`
import + generic if the file uses a different pattern.)

**Verify:**
```
bun test runtime/treaty.test.ts
bunx biome ci runtime/treaty.ts runtime/treaty.test.ts
```
Expected: pass; biome 0.

---

## B3 — Body-coercion e2e

**Edit `tests/fixtures/app/actions.ts`** — add an upload endpoint:
```ts
  .post('/upload', ({ body }) => ({ name: (body as { name: string }).name }), {
    body: z.object({ name: z.string() }),
  })
```
(Text-only keeps the integration assertion simple; multipart File round-trip is
unit-covered in B1.)

**Edit `tests/integration.test.ts`** — add:
```ts
test('action: urlencoded body coerces + validates', async () => {
  const r = await fetch(`http://127.0.0.1:${sharedPort()}/_brust/action/upload`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'name=alice',
  })
  expect(r.status).toBe(200)
  expect(await r.json()).toEqual({ name: 'alice' })
})
test('action: multipart body coerces + validates', async () => {
  const fd = new FormData(); fd.append('name', 'bob')
  const r = await fetch(`http://127.0.0.1:${sharedPort()}/_brust/action/upload`, { method: 'POST', body: fd })
  expect(r.status).toBe(200)
  expect(await r.json()).toEqual({ name: 'bob' })
})
```

**Verify:**
```
bun test tests/integration.test.ts
bunx biome ci tests/fixtures/app/actions.ts tests/integration.test.ts
```
Expected: pass.

---

## C1 — Prefix injection (inject module + stream both paths + run wiring)

**New `runtime/render/inject-action-prefix.ts`** — copy `inject-dev-client.ts`
structure exactly, renamed. Read `inject-dev-client.ts` first and mirror it
(including the warn-once flag + `_resetWarnedForTests` export + the byte-scan
`findHeadCloseTag` copy). Skeleton:
```ts
let warned = false
export function _resetWarnedForTests(): void { warned = false }

/** Splice `snippet` (a full <script>…</script>) immediately before the first
 * </head>. No-op if snippet is null/empty or </head> is absent. */
export function injectActionPrefix(body: Uint8Array, snippet: string | null): Uint8Array {
  if (!snippet) return body
  const idx = findHeadCloseTag(body)
  if (idx < 0) {
    if (!warned) { console.warn('[brust] action-prefix: no </head> in first chunk; global not injected'); warned = true }
    return body
  }
  const enc = new TextEncoder().encode(snippet)
  const out = new Uint8Array(body.length + enc.length)
  out.set(body.subarray(0, idx), 0)
  out.set(enc, idx)
  out.set(body.subarray(idx), idx + enc.length)
  return out
}

function findHeadCloseTag(body: Uint8Array): number { /* copy from inject-dev-client.ts verbatim */ }
```

**New module-scope config** — add to the SAME file (or a tiny
`runtime/render/action-prefix.ts`; pick one and be consistent):
```ts
let snippet: string | null = null
export function configureActionPrefixSnippet(s: string | null): void { snippet = s }
export function getActionPrefixSnippet(): string | null { return snippet }
```

**Edit `runtime/render/stream.ts`:**
- import: `import { injectActionPrefix, getActionPrefixSnippet } from './inject-action-prefix.ts'`
- buffering path (after line 150 `injectDevClient`):
  ```ts
  body = injectActionPrefix(body, getActionPrefixSnippet())
  ```
- streaming path (line 210-212): add `prefixTag` to the prepend:
  ```ts
  const devTag = getDevClientSnippet() ?? ''
  const prefixTag = getActionPrefixSnippet() ?? ''
  if (linkTagsStr.length > 0 || devTag.length > 0 || prefixTag.length > 0) {
    const prepend = encoder.encode(linkTagsStr + prefixTag + devTag)
    // …existing out = new Uint8Array(...) splice…
  }
  ```

**Edit `runtime/index.ts run()`** — in BOTH the main (`if (!isWorker)`) and
worker startup branches, near where `configureDevClientSnippet` is set
(~line 301-307 main, ~589-590 worker), add (gated on a non-default custom
prefix):
```ts
{
  const { configureActionPrefixSnippet } = await import('./render/inject-action-prefix.ts')
  const ap = opts.actionPrefix
  configureActionPrefixSnippet(
    ap && ap !== '/_brust/action'
      ? `<script>globalThis.__BRUST_ACTION_PREFIX__=${JSON.stringify(ap)}</script>`
      : null,
  )
}
```
Place this UNCONDITIONALLY (not only in dev) — it's gated on the custom-prefix
check, and the default-prefix case sets null (zero overhead). Put it outside the
`if (dev)` block in both branches.

**Test** — `runtime/render/inject-action-prefix.test.ts` (mirror
`inject-dev-client.test.ts`):
```ts
import { test, expect } from 'bun:test'
import { injectActionPrefix, _resetWarnedForTests } from './inject-action-prefix.ts'
const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)
test('splices before </head>', () => {
  const out = injectActionPrefix(enc('<head><title>x</title></head><body>'), '<script>S</script>')
  expect(dec(out)).toBe('<head><title>x</title><script>S</script></head><body>')
})
test('no-op when snippet null', () => {
  const b = enc('<head></head>'); expect(injectActionPrefix(b, null)).toBe(b)
})
test('no-op (warns once) when </head> absent', () => {
  _resetWarnedForTests()
  const b = enc('<body>no head</body>'); expect(dec(injectActionPrefix(b, '<script>S</script>'))).toBe('<body>no head</body>')
})
```

**Verify:**
```
bun test runtime/render/inject-action-prefix.test.ts
bunx biome ci runtime/render/inject-action-prefix.ts runtime/render/stream.ts runtime/index.ts runtime/render/inject-action-prefix.test.ts
bun test runtime/
```
Expected: new test passes; biome 0; full runtime suite still green.

---

## C2 — Custom-prefix e2e

**Edit `tests/fixtures/app/index.ts`** — thread an env-driven prefix:
```ts
await brust.run({
  routes,
  entry: import.meta.url,
  actions,
  actionPrefix: process.env.BRUST_ACTION_PREFIX || undefined,
})
```

**Edit `tests/integration.test.ts`** — extend `startServer` to accept env, and
add a custom-prefix test. First, `startServer` signature:
```ts
async function startServer(opts: { workers?: string; rustLog?: string; cmd?: string[]; env?: Record<string, string> } = {}) {
  // …existing… in the spawn env object add:  ...(opts.env ?? {}),
```
Then the test (uses startServer, NOT shared — custom config):
```ts
test('custom actionPrefix: routes under prefix + injects browser global', async () => {
  const { port, stop } = await startServer({ rustLog: 'brust=warn', env: { BRUST_ACTION_PREFIX: '/api' } })
  try {
    // (a) action routes under the custom prefix
    const ok = await fetch(`http://127.0.0.1:${port}/api/notes`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hi' }),
    })
    expect(ok.status).toBe(200)
    // default prefix no longer routes
    const def = await fetch(`http://127.0.0.1:${port}/_brust/action/notes`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hi' }),
    })
    expect(def.status).toBe(404)
    // (b) a non-Suspense HTML page injects the global before </head>
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text()
    expect(html).toContain('globalThis.__BRUST_ACTION_PREFIX__="/api"')
    expect(html.indexOf('__BRUST_ACTION_PREFIX__')).toBeLessThan(html.indexOf('</head>'))
  } finally {
    await stop()
  }
}, 15_000)
```
NOTE: `/` must be a buffering-path (non-Suspense) page. If `/` streams, pick
another simple SSR route from the fixture that the existing tests treat as a
single-chunk page. Confirm by checking which page the existing
`'Hello from Brust'` test hits.

**Verify:**
```
bun test tests/integration.test.ts
bunx biome ci tests/fixtures/app/index.ts tests/integration.test.ts
```
Expected: pass. If the injected-global assertion fails because `/` is a
streaming page, switch the asserted route (do NOT remove the assertion).

**BLOCKED fallback (C2):** if NO fixture page is buffering-path (all stream),
assert the global on whichever page renders and adjust the `indexOf` ordering
check to just `.toContain` (the streaming path appends the script after the
bootstrap, not before `</head>`). Report which path the fixture uses.

---

## Final gate (orchestrator, Phase 6)
```
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
cargo test -p brust
bunx biome ci .
bun test runtime/
bun test tests/treaty-integration.test.ts
bun test tests/integration.test.ts
rm -rf tests/fixtures/app/.brust tests/fixtures/app/dist && bun test tests/native-island.test.ts tests/native-island-ssr.test.ts
```
Manual smoke: boot fixture with `BRUST_ACTION_PREFIX=/api`, curl `/api/notes` +
`GET /` and eyeball the injected `<script>`.

## Phase D — bench (post-pipeline, mechanical)
Re-run the bench (`scripts/benchmark.ts` → `POST /notes {"text":"hi"}`) and
refresh `bench/.../RESULTS.md` stale `/createNote` numbers. Per memory
`brust-perf-bench-caveats`, numbers are macOS-indicative — label the platform,
don't present as Linux-comparable. If the harness won't run locally, note it and
leave RESULTS.md with a dated "pending Linux re-measure" note rather than stale
numbers.
</content>
