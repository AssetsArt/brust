# SPA shell signature — implementation plan

Spec: `docs/superpowers/specs/2026-06-13-spa-shell-signature-design.md` (verified against code). Branch: `feat/spa-shell-signature`.

Verified facts driving the plan:
- `makeFlat(chain, fullPath)` builds `FlatRoute` with `chain: Route[]` (routes.ts ~767); `Route.Component` (server-side `.name` stable) + `.path` available. Add `shellId` here.
- `fetchPagePayload` returns the WHOLE parsed JSON and `setCachedPage` stores it (page-cache.ts:63,95) → a server-added `shell` field round-trips through cache to the client automatically; only the `PagePayload` TYPE needs `shell?`.
- NATIVE routes render via `napiRenderJinja` (NOT renderBranchStreaming) → meta must BAKE AT EMIT (native-routes-emit.ts, mirror `insertGeneratorMeta`). NON-native (React) routes render via `renderBranchStreaming` → inject at render (mirror `injectGeneratorMeta`, which runs at BOTH the buffering site ~179 and the streaming-prepend site ~229+). This is exactly the generator-meta dual-path split.
- `navigationBranch` has `flat` in scope (~1765) → add `shell: flat.shellId` to the payload JSON.

## Task 1 — shellId on FlatRoute (TDD)
routes.ts: add `shellId: string` to `FlatRoute`; compute in `makeFlat`:
```
const ancestors = chain.slice(0, -1)
const routeIdent = (r: Route) => r.Component?.name || r.path || '?'
const shellId = ancestors.length > 0
  ? 'L:' + ancestors.map(routeIdent).join('>')
  : 'S:' + routeIdent(chain[chain.length - 1])
```
Unit test (routes flatten test if one exists, else a focused test): layout-wrapped leaves share `L:`, standalone leaves get distinct `S:`. Commit.

## Task 2 — React render inject (TDD)
- New `runtime/render/inject-shell-meta.ts` mirroring `runtime/render/inject-generator.ts`: `injectShellMeta(body: Uint8Array, shellId: string): Uint8Array` — find `</head>`, insert `<meta name="brust-shell" content="<shellId>">` before it, insert-if-absent guarded by a `name="brust-shell"` byte check (GUARD), no-op on empty shellId. Mirror inject-generator's findHeadClose + bytesInclude.
- `runtime/render/stream.ts`: thread `shellId` into `RenderBranchStreamingArgs`; call `injectShellMeta(body, args.shellId)` at BOTH sites generator uses (buffering ~179 AND streaming prepend ~229 — add the meta string to the prepend concat).
- routes.ts render branch: pass `shellId: flat.shellId` into the renderBranchStreaming args (next to storeSnapshot).
- Tests: inject-shell-meta.test.ts (insert/idempotent/empty no-op); existing stream tests stay green. Commit.

## Task 3 — native emit bake (TDD)
native-routes-emit.ts: where `insertGeneratorMeta(withDirectives, generatorMeta)` runs (~765), also bake the shell meta for the flat route being emitted. The shellId per emitted native template = compute from its chain (the emit loop has the route/chain; if it has fullPath/template only, thread shellId from the flat routes — the emit input already carries route info; reuse whatever carries generatorMeta-adjacent per-route data). Insert `<meta name="brust-shell" content="...">` before `</head>` (same insertion helper as generator, or reuse insertGeneratorMeta-style). 
- BLOCKED-fallback: if the emit loop doesn't have the chain/shellId handy, compute shellId in routes.ts and pass it through the emit input map keyed by template name; do NOT recompute divergently.
- Test (native-routes-emit.test.ts): emitted composed template head contains `<meta name="brust-shell" content="L:...">` for a layout-wrapped route and `S:...` for a standalone one. Commit.

## Task 4 — nav payload + client guard (TDD)
- routes.ts navigationBranch (~1765): `const body = JSON.stringify({ html: innerHtml, title, store, shell: flat.shellId })`.
- page-cache.ts: `PagePayload` gains `shell?: string` (round-trips automatically).
- bootstrap.ts:
  - module var: `let currentShell = (typeof document !== 'undefined' ? document.querySelector('meta[name="brust-shell"]')?.getAttribute('content') : null) ?? null` (set at module init / boot).
  - in `navigate()`, immediately before the existing `if (isFullDocumentPayload(html))` guard, add:
    ```
    if (currentShell && payload.shell && payload.shell !== currentShell) { location.href = url.href; return }
    ```
  - same guard in `attemptClientFallback` before its `isFullDocumentPayload` check (payload.shell vs currentShell).
  - Do NOT mutate currentShell on same-shell swap (head meta persists; sig unchanged).
- Tests (bootstrap nav test, happy-dom): seed a meta + a navigator; payload.shell≠currentShell → location full-load, no swap; ==→ swap; payload without shell OR no meta → swap (fallthrough); cache-hit with differing shell → full load. Commit.

## Task 5 — integration + addon rebuild + docs
- Rebuild addon (`cd runtime && bun run build:debug`) — native emit changed.
- Integration test (tests/): a fixture with a LAYOUT route (Outlet) wrapping an index + a sibling STANDALONE route. Assert `/_brust/page/<standalone>` payload `shell` differs from the layout route's; assert a same-layout sibling shares shellId; assert the served full documents each carry the `<meta name="brust-shell">`. (The client full-load is unit-tested in Task 4 — integration asserts the server contract.) Reuse the fixture app if it already has a layout+standalone pair; else add minimal routes.
- Docs: architecture.md SPA-nav section + routing/native docs — "navigating across a layout boundary triggers a full document load (correct shell); same-layout navigation stays a fast in-place swap."
- Gates: full `bun test` (pre-existing cli-build stylesheet fail exempt; rebuild addon first to avoid stale-napi CORS-style failures), `bun run ci`, `cargo test -p brust-core` (expect untouched — no Rust change). Commit.

## Verification of the actual bug
After Task 5, document (in the PR) the trace proving the studio cases now full-load: `/login`(S:LoginPage) → `/`(L:AppLayout) mismatch → full load → AppLayout renders; `/`→`/login` mismatch → full load → AppLayout gone. Same-AppLayout sibling nav unaffected.

## Spec coverage map
| Spec section | Task |
|---|---|
| shellId compute | 1 |
| React render inject (both sites) | 2 |
| native emit bake | 3 |
| nav payload + client guard + fallback path | 4 |
| integration + docs + addon | 5 |
