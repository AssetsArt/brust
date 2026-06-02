# Treaty Action System — Completion (HEAD, body coercion, multipart, prefix injection)

Date: 2026-06-01
Status: Draft (brainstorm done), pending spec review
Builds on: `2026-06-01-actions-treaty-client-design.md` (the shipped treaty
system) — this spec lands that design's **documented follow-ups**.

## Goal

Close the four remaining gaps in the treaty action system named in the project
handoff:

1. **HEAD method** — the treaty design lists `.head`, but no builder method
   exists (only get/post/put/patch/delete). Add `.head`; the client proxy
   already supports it.
2. **e2e coverage gap** — PUT/PATCH/HEAD/custom-prefix/query-schema-422 are
   unit-covered only. The integration fixture has just POST/GET/DELETE. Add
   real-server integration cases.
3. **Body coercion** — `dispatchAction` decodes JSON only. Decode
   `application/x-www-form-urlencoded` and `multipart/form-data` (the Rust wire
   already ships multipart as `body_b64` + `content_type`) into a plain object
   before Standard Schema validation, so a schema on a form endpoint becomes a
   *runtime* check, not just a type contract. Plus: the treaty **client**
   auto-sends `multipart/form-data` when the body contains a `File`/`Blob`.
4. **Prefix injection** — when an app customizes `actionPrefix`, the server
   injects `globalThis.__BRUST_ACTION_PREFIX__` into rendered HTML so the
   browser `client<App>()` auto-discovers it (today the browser must pass
   `client({ prefix })` explicitly; the client already *reads* the global).

## Non-goals (explicit)

- **NOT auto-deriving HEAD from GET.** `.head` must be declared explicitly
  (matches the treaty spec's resolved decision; keeps the Rust method table
  simple).
- **NOT response-body streaming or output validation.** Unchanged.
- **NOT a multipart *response* path.** Only request bodies decode multipart;
  responses stay single-chunk JSON.
- **NOT File-content validation semantics.** Decoded `File`/`Blob` entries pass
  through into the validated object as-is; a schema validating files uses
  `z.instanceof(File)` / `z.any()`. We do not read file bytes for validation.
- **NOT changing the Rust wire.** Rust already ships `content_type`,
  `body_text`, and `body_b64`. No `crates/` edits in this spec (confirm in
  Phase 6).
- **NOT prefix injection into every conceivable render path in one shot.**
  Covered: the React-SSR stream path and the native/jinja bake path. Other
  exotic emit paths (if any) are a follow-up, named loudly.

## High-level architecture

Three runtime subsystems, each independently testable; one mechanical bench.

```
A. Builder breadth      define-actions.ts  .head()  + accumulated HEAD type
   (client proxy already has head; fixture + integration add PUT/PATCH/HEAD/query-422)

B. Body coercion        routes.ts dispatchAction: decode by content-type
   ┌ application/json            → JSON.parse(body_text)           (today)
   ├ x-www-form-urlencoded       → Object.fromEntries(URLSearchParams(body_text))
   └ multipart/form-data         → Response(b64→bytes, {ct}).formData() → object
   client/treaty.ts: body has File/Blob → build FormData, omit JSON content-type
                     (let fetch set the multipart boundary)

C. Prefix injection     render/inject-action-prefix.ts  (mirror inject-dev-client.ts)
   stream.ts: splice <script>globalThis.__BRUST_ACTION_PREFIX__="…"</script> before </head>
   native-routes-emit.ts: bake the same script beside the islands importmap
   index.ts run(): configureActionPrefixSnippet(prefix) when prefix !== default

D. bench (mechanical)   re-measure POST /notes {"text":"hi"} → refresh RESULTS.md
```

## API / behavior surface

### Phase A — `.head` builder

`runtime/define-actions.ts`:
- Add to `ActionsBuilder<Acc>`:
  ```ts
  head<P extends string, O extends EndpointOptions, R>(
    path: P,
    handler: Handler<BodyOf<O>, Params<P>, QueryOf<O>, R>,
    opts?: O,
  ): ActionsBuilder<Acc & { [K in P]: { HEAD: { input: QueryOf<O>; output: Awaited<R> } } }>
  ```
  (mirror `get` — bodyless, `input` is the query type.)
- Add to the runtime builder object:
  ```ts
  head(p: string, h: any, o?: EndpointOptions) { add('HEAD', p, h, o); return builder },
  ```
- `EndpointDef.method` already includes `'HEAD'`; `dispatchAction` already treats
  HEAD as bodyless (`def.method !== 'GET' && def.method !== 'HEAD'`). No dispatch
  change. Note: HEAD responses still carry a JSON body string from the handler;
  the HTTP layer (Rust) is responsible for dropping the body on the wire for
  HEAD — the integration test asserts status + headers, not body bytes
  (confirm Rust HEAD behavior in Phase 6; if Rust ships the body, the test
  asserts what actually happens and we note it).

### Phase B — body coercion + client multipart

**Server (`runtime/routes.ts` `dispatchAction`)** — replace the JSON-only decode
block (~line 1113-1128) with content-type dispatch. New helper
`decodeActionBody(call): { ok: true; value: unknown } | { ok: false; status; body }`:
- method GET/HEAD → `undefined` (unchanged).
- content-type starts `application/json` (or empty/missing → default JSON):
  `body_text ? JSON.parse : undefined`; parse error → 400 (unchanged shape).
- content-type starts `application/x-www-form-urlencoded`:
  `Object.fromEntries(new URLSearchParams(call.body_text ?? ''))` → object of
  string values. No throw path (URLSearchParams is lenient).
- content-type starts `multipart/form-data`:
  - decode bytes: `Buffer.from(call.body_b64 ?? '', 'base64')`.
  - `const fd = await new Response(bytes, { headers: { 'content-type': call.content_type } }).formData()`.
  - `Object.fromEntries(fd.entries())` → object; text fields are strings, file
    fields are `File` objects. (Multiple same-name fields collapse to the last —
    acceptable for v1; arrays are a follow-up.)
  - On decode failure (bad boundary / malformed) → 400 with
    `{error:{message:'invalid multipart body: …'}}`.
- The decoded object feeds the existing `validate(def.body, rawBody)` →
  422-on-failure path unchanged.

Coercion runs BEFORE validation, so a Zod schema on a form endpoint validates
the coerced object. The query path is unchanged (`req.search` is already a parsed
object).

**Client (`runtime/treaty.ts`)** — in the method terminal, when sending a body
for a non-bodyless method:
- detect a `File`/`Blob` anywhere in the top-level body object values (or the
  body itself being FormData):
  ```ts
  function hasFilePart(b: unknown): boolean {
    if (b instanceof FormData || b instanceof Blob) return true
    if (b && typeof b === 'object')
      return Object.values(b).some((v) => v instanceof Blob)
    return false
  }
  ```
- if FormData → send as-is.
- if a plain object containing a top-level File/Blob → build `FormData`,
  appending each entry (Blob/File appended directly; everything else `String(v)`
  — except nested plain objects which are JSON-stringified).
- otherwise → JSON (today's path).
- **For the FormData branch, actively `delete (init.headers as Record<string,
  string>)['content-type']`** (resolved: spec review) — not merely skip setting
  it. A caller-provided `options.headers['content-type']` would otherwise carry a
  stale value and break the multipart boundary; `fetch` only auto-sets the
  boundary when content-type is absent.
- **Known limitation (loud):** detection is TOP-LEVEL only. A `File` nested
  inside a sub-object (`{ doc: { file } }`) is NOT detected → goes through JSON
  and the File serializes to `{}` (lost). Nested-File upload is a follow-up.

`Blob`/`File`/`FormData` are web globals available in Bun and browsers.

### Phase C — prefix injection

- New `runtime/render/inject-action-prefix.ts`, mirroring
  `inject-dev-client.ts` **exactly**: `injectActionPrefix(body: Uint8Array,
  snippet: string | null): Uint8Array` splices `snippet` (a full
  `<script>…</script>`) before the first `</head>` (byte-scan). **Resolved (spec
  review): no shared `</head>` scanner exists today — `findHeadCloseTag` is
  duplicated identically in `inject-css-link.ts` and `inject-dev-client.ts`. To
  minimize blast radius, ADD A THIRD COPY in the new file, mirroring
  `inject-dev-client.ts` including its warn-once flag + `_resetWarnedForTests`
  export (the `inject-*.test.ts` convention resets it).**
- New module-scope config in a small module (e.g.
  `runtime/render/action-prefix.ts` or fold into the inject file):
  `configureActionPrefixSnippet(s: string | null)` / `getActionPrefixSnippet()`.
- `runtime/render/stream.ts` has TWO render paths (resolved: spec review) —
  BOTH must inject:
  1. **Buffering path** (~line 149-150, non-Suspense pages): after
     `injectCssLink` + `injectDevClient`, add
     `body = injectActionPrefix(body, getActionPrefixSnippet())`.
  2. **Streaming/Suspense path** (~line 210, where `</head>` ships in a later
     React chunk so splicing can't run, and the dev tag is instead *appended*
     after the bootstrap as `devTag`): append the prefix snippet there too,
     parallel to `devTag` (e.g. `const prefixTag = getActionPrefixSnippet() ??
     ''` and include it in the same prepend). Missing this silently drops the
     global on Suspense pages.
  The Phase-C integration test MUST target a **non-Suspense (buffering-path)**
  page for a deterministic assertion (the mode is chosen at stream.ts ~line
  185-193, `allReadyFired` → buffering).
- `runtime/index.ts run()` (BOTH main + worker startup, like the dev snippet):
  when `opts.actionPrefix` is set AND `!== '/_brust/action'`, call
  `configureActionPrefixSnippet('<script>globalThis.__BRUST_ACTION_PREFIX__=' +
  JSON.stringify(prefix) + '</script>')`. Default prefix → leave null (client
  falls back to the default with no injection — zero overhead for the common
  case).
- **Native/jinja path** (`runtime/cli/native-routes-emit.ts`, where
  `ISLANDS_IMPORTMAP_AND_BOOTSTRAP` is baked ~line 285): when a custom prefix is
  configured at build time, bake the same `__BRUST_ACTION_PREFIX__` script
  beside the importmap. **Open question (resolve at plan time):** is
  `actionPrefix` known at `brust build` time? If build doesn't receive it, the
  native-bake injection is deferred and named loudly — the React-SSR stream path
  is the primary deliverable.
- Escaping: the script value is `JSON.stringify(prefix)`; the prefix is already
  validated server-side (`isValidEndpointPath`-style: starts `/`, no
  whitespace/`?#`), so no `</script>` breakout risk, but still place it in a
  plain `<script>` (not JSON island) — a prefix cannot contain `<`.

## Tests / acceptance criteria

### Phase A
Unit (`runtime/define-actions.test.ts` or action-dispatch): `.head` accumulates a
HEAD endpoint; duplicate `HEAD path` throws; HEAD dispatch is bodyless.
Integration (`tests/integration.test.ts`, shared or startServer):
- `PUT /notes/{id}` round-trips (fixture handler returns the updated note).
- `PATCH /notes/{id}` round-trips.
- `HEAD /notes/{id}` → 200 (assert status + a header; body asserted to whatever
  Rust actually returns for HEAD — see SA note).
- query-schema 422: an endpoint with a `query` Zod schema returns 422 on invalid
  query (e.g. `?limit=abc` where `limit: z.coerce.number()`).

Fixture additions (`tests/fixtures/app/actions.ts`): `.put('/notes/{id}', …)`,
`.patch('/notes/{id}', …)`, `.head('/notes/{id}', …)`, and a
`.get('/search', …, { query: z.object({ limit: z.coerce.number() }) })` (or
similar) for the 422 case.

### Phase B
Unit (`runtime/action-dispatch.test.ts`): urlencoded body → coerced object →
validates; multipart body (construct via `new Response(formData).…` to get bytes
→ b64) → coerced object with text + File entries → validates; malformed
multipart → 400.
Unit (`runtime/treaty.test.ts`): body with a `Blob` → `init.body` is FormData and
no JSON content-type set; FormData body passed directly → sent as-is; plain
object → JSON (regression).
Integration: POST an urlencoded body to a form endpoint → 200; POST multipart
with a text field + a small file → 200 and the handler sees the field.
Fixture: a `.post('/upload', ({ body }) => …, { body: z.object({ name:
z.string(), file: z.instanceof(File).optional() }) })` (or text-only to keep it
simple) exercised by the multipart/urlencoded tests.

### Phase C
Unit (`runtime/render/inject-action-prefix.test.ts`): splices before `</head>`;
no-op when snippet null or `</head>` absent.
Integration: boot the fixture with a custom `actionPrefix` (via
`BRUST_ACTION_PREFIX` env → fixture `index.ts` reads it → `brust.run({
actionPrefix })`); assert (a) an action routes under the custom prefix (e.g.
`POST <prefix>/notes` 200, and the default `/_brust/action/notes` is 404), and
(b) a rendered HTML page contains
`globalThis.__BRUST_ACTION_PREFIX__="<prefix>"` before `</head>`.
Harness: extend `startServer` to accept `env?: Record<string,string>` merged
into the spawn env; fixture `index.ts`:
`actionPrefix: process.env.BRUST_ACTION_PREFIX || undefined`.

### Baselines that must stay green (project gates)
`cargo fmt --check`, `cargo clippy --all-targets --locked -- -D warnings`,
`cargo test -p brust`, `bunx biome ci .`, `bun test runtime/`,
`tests/treaty-integration.test.ts`, `tests/integration.test.ts`,
native-island{,-ssr}. `cli-build.test.ts /native-islands` failure is
pre-existing/out-of-gate.

## Phasing (be loud — single autonomous run may truncate)

- **A** (lowest risk, additive): HEAD builder + e2e breadth. Priority.
- **B** (medium-high): body coercion server + client multipart. Multipart parse
  via `Response.formData()` is the load-bearing unknown — verify empirically.
- **C** (medium): prefix injection. Native-bake sub-step gated on build-time
  prefix availability (may defer).
- **D** (mechanical, separate): bench RESULTS.md re-measure. No spec/plan; run
  the bench and refresh numbers; if the bench harness can't run locally
  (macOS≠Linux caveat, memory `brust-perf-bench-caveats`), report numbers as
  indicative and note the platform.

If truncated, ship A first, then B, then C; D last. Report honestly what landed.

## Known limitations / deferred
- Multipart **arrays** (repeated field names) collapse to last value; array
  coercion is a follow-up.
- File-content validation is pass-through (`z.instanceof(File)`), no byte
  inspection.
- Native/jinja prefix injection may be deferred if `actionPrefix` isn't known at
  `brust build` time (the dev/`run()` SSR path is the primary deliverable).
- bench numbers are platform-indicative on macOS (see perf-bench memory).

## Resolved (spec review + empirical probe)
1. **Rust ships the HEAD response body — it does NOT strip it.**
   `dispatch_single_chunk` (server.rs:469 / ~1517-1527) writes the handler's
   full JSON body unconditionally with no HEAD branch. So a HEAD action returns
   the body on the wire. The Phase-A HEAD test asserts status + a header and
   documents that the body is currently shipped (RFC-correct stripping would be
   a separate Rust change, out of scope — no `crates/` edits here).
2. **Native-jinja prefix bake DEFERRED.** `actionPrefix` is a `brust.run()`
   runtime option (index.ts only); it is NOT a build input (`build.ts` /
   `native-routes-emit.ts` never see it). The React-SSR stream path (both
   buffering + streaming) is the Phase-C deliverable; native-route custom-prefix
   injection is a named follow-up.
3. **Multipart decode CONFIRMED** in this Bun: `FormData → Response bytes → b64 →
   Buffer.from → new Response(bytes,{ct}).formData() → Object.fromEntries` yields
   string text fields + real `File` objects (bytes + name intact). The Rust wire
   populates `body_b64` for multipart (routes.rs:192-193) and `body_text` for
   json/urlencoded — both reach `dispatchAction` as assumed.
</content>
