# Generator tag + X-Powered-By header — design

**Date:** 2026-06-12 · **Status:** approved (user-approved in conversation, build-time-bake variant)

## Goal

Every site built with brust identifies itself to technology detectors (Wappalyzer
and friends) via the two standard fingerprint surfaces:

1. `<meta name="generator" content="brust <version>"/>` in the `<head>` of every
   HTML page (native routes, md pages, React-streamed routes, SSG output).
2. `X-Powered-By: brust/<version>` HTTP header on every response served by the
   brust server (HTML, actions/JSON, static assets, cache HITs).

The **name ("brust") is mandatory and cannot be disabled.** The **version part is
optional**: `brust build --no-generator-version` (and the same flag on
`brust dev`) drops it, leaving `content="brust"` / `X-Powered-By: brust`.
The decision is **baked at build time** — flipping it requires a rebuild. This is
the user's explicit choice (no serve-time config).

Version source of truth: the `brustjs` npm package version read from the
package's own `package.json` (same pattern as `runtime/cli/help.ts:13`). The
Rust crate versions (`0.1.0`) are NOT user-facing and are never used.

## Non-goals

- No serve-time `ServeOptions` toggle. The toggle is a build/dev CLI flag only.
- No way to disable the name. No way to customize the strings.
- Submitting the actual Wappalyzer/webappanalyzer fingerprint PR — follow-up
  outside this repo (the meta + header emitted here are exactly the standard
  fields those fingerprints match on).
- No `Server:` header changes; hyper's defaults stay as-is.

## High-level architecture

One resolved-string decision, made once at build, consumed by three emitters:

```
brust build [--no-generator-version]          brust dev [--no-generator-version]
        │                                              │
        ▼                                              ▼
  generatorStrings(versionOn) ──► { meta: 'brust 0.1.48-alpha', header: 'brust/0.1.48-alpha' }
        │
        ├─ (b — written FIRST) generator.json artifact written into every
        │      jinja out dir (created even for React-only apps with zero
        │      native routes): { "meta": "<full meta tag>", "header": "brust/x.y.z" }
        │      build.ts and dev.ts are the ONLY writers; the flag's whole
        │      effect is this artifact + the templates baked from it.
        │
        ├─ (a) native + md jinja templates: literal insert of the meta tag
        │      right after the compiler-emitted viewport meta, applied to the
        │      compileJsx output before it is written to disk. The emitters
        │      resolve the meta tag INTERNALLY (read the out dir's
        │      generator.json, fallback = version-on) — NOT a caller param —
        │      because emit re-runs from FIVE call sites and a param would
        │      silently drop the tag on re-emit: build.ts, dev.ts,
        │      runtime/index.ts:507 + :733 (md re-emit at every boot/hot
        │      reload), runtime/index.ts:617 (boot staleness re-emit), and
        │      runtime/dev/jinja-reload.ts:24 (dev HMR re-emit). Internal
        │      resolution makes every re-emit self-consistent with zero
        │      changes at those call sites. The `.brust/jinja` dual-emit is
        │      a post-emit copy of the already-inserted files (build.ts:478),
        │      so one insert covers both dirs; generator.json is written to
        │      both dirs alongside.
        │
        └─ (c) consumed at serve time:
               • React streaming: runtime/render/stream.ts injects the meta
                 tag into <head> at the same point as injectCssLink, via a
                 configured singleton (runtime/render/generator.ts) seeded
                 from <jinjaDir>/generator.json by BOTH the main isolate and
                 the worker isolates (mirror of configureCssHrefsForRoute —
                 the worker-not-configured trap is known and load-bearing).
               • X-Powered-By: runtime/index.ts serve() reads the same
                 artifact and threads `generator` through napi ServeOptions
                 (crates/brust/src/lib.rs — single-word field, no
                 snake_case/camelCase mismatch possible) into brust-core
                 server state. The stamp lives in the service_fn wrapper
                 closure at crates/brust-core/src/server/mod.rs:234 (NOT
                 inside handle_request, which has ~15 early returns):
                 every path — render, action, static, chunks, cache HIT,
                 SAB fast-lane (builds a hyper Response, never writes the
                 socket directly), streaming, WS 101 — returns through it.
                 Cached framed bytes are captured pre-stamp (write-back
                 happens inside dispatch), so stamping HITs at the wrapper
                 produces no duplicate header.
```

SSG (`brust build --ssg`) crawls the live server, so the static HTML inherits
the meta tag with zero extra work. Static hosts will not send the header —
documented limitation.

### Exact emitted strings

- Meta (version on): `<meta name="generator" content="brust 0.1.48-alpha"/>`
- Meta (version off): `<meta name="generator" content="brust"/>`
- Header (version on): `X-Powered-By: brust/0.1.48-alpha`
- Header (version off): `X-Powered-By: brust`

The version substring is whatever `package.json#version` says at build time —
prerelease suffixes included, no `v` prefix.

### Insertion anchor (jinja)

The Rust compiler (`crates/jsx-rust-compiler/src/emit_jinja.rs:110`) emits the
literal `<meta name="viewport" content="width=device-width, initial-scale=1"/>`
in every document head. The TS-side insert anchors on that exact literal and
places the generator meta immediately after it. The anchor is compiler-owned
and stable; if it is ever missing (non-document template), the insert is a
no-op — never an error.

### React-path injection — two branches of stream.ts

- **Buffered branch** (`stream.ts:177`, the common case): inject before
  `</head>` alongside `injectCssLink`, with a duplicate guard — skip when the
  buffered HTML already contains `name="generator"` (cheap substring check) so
  a hand-authored generator meta (e.g. via `BrustPage head={[…]}`) wins.
- **Streaming-Suspense branch** (`stream.ts:222-254`): the document head
  arrives in later chunks that bypass injection, so the meta tag is PREPENDED
  with the other first-chunk tags before `<!DOCTYPE>`. In the raw bytes it
  sits outside `<head>`; the HTML parser fosters it into `<head>`, so DOM-based
  detectors (the Wappalyzer extension) and raw-regex detectors both match.
  No duplicate guard is possible there (head bytes not visible yet) — a
  hand-authored generator meta on a streaming route yields two tags in the
  DOM. Accepted, documented limitation; detectors take the first match.

The jinja path needs no guard: the insert runs once at emit time on fresh
compiler-produced output. `BrustPage`'s React mirror is NOT modified —
stream-level injection covers every React route whether or not it uses
`BrustPage`.

### Fallback behavior (old dist / missing artifact)

If `<jinjaDir>/generator.json` is absent (dist built by an older brustjs), the
serve-time consumers fall back to **version-on** strings computed from the
installed brustjs `package.json`. Rationale: default behavior is version-on;
only an explicit `--no-generator-version` build produces an artifact that says
otherwise, and that artifact is always written by builds that know the flag.

## CLI surface

- `brust build --no-generator-version` — bake name-only strings.
- `brust dev --no-generator-version` — same semantics for the dev server.
- No flag → version-on (default). Unknown-flag errors stay strict
  (`parseArgs` in `runtime/cli/build.ts:152` already throws on unknown flags;
  dev gets the same treatment in its own arg handling).

## File structure (planned changes)

| File | Change |
|---|---|
| `runtime/generator.ts` (new) | `generatorStrings(versionOn: boolean)` + `insertGeneratorMeta(jinja, metaTag)` + `resolveGeneratorMeta(outDir)` (artifact read, version-on fallback) + artifact write + version read (help.ts pattern) |
| `runtime/cli/build.ts` | parse `--no-generator-version`; write `generator.json` to all jinja out dirs BEFORE emit (dual-emit; always, even for React-only apps) |
| `runtime/cli/dev.ts` | same flag (dev's existing reject-unknown-flags handling); write the artifact before the initial emit/boot so all re-emits and serve consumers read it |
| `runtime/cli/native-routes-emit.ts` | resolve meta internally from the out dir's generator.json (fallback version-on) and insert after compileJsx, before the jinja write — covers all five emit call sites with no caller changes |
| `runtime/md/emit.ts` | same internal resolve + insert on the md wrapper-compile path (insert anchors in the head; md renumbering touches only the spliced body, no conflict) |
| `runtime/render/generator.ts` (new) | configured singleton: `configureGenerator(meta: string \| null)` / `getGeneratorMeta()` |
| `runtime/render/stream.ts` | buffered branch: inject next to `injectCssLink` (dupe guard); streaming branch: prepend with the first-chunk tags (no guard) |
| `runtime/index.ts` | main + worker boot: read `<jinjaDir>/generator.json` (main configures jinjaDir at :634, worker at :970), seed the singleton, thread `generator` header string into napi ServeOptions |
| `crates/brust/src/lib.rs` | `ServeOptions.generator: Option<String>`; validate single-line ASCII; store in server state (pattern of `action_prefix` at :57/:166) |
| `crates/brust-core/src/server/mod.rs` | stamp `X-Powered-By` in the service_fn wrapper closure (:234), insert-if-absent |
| `example/docs/content/cli.md` | document the flag |
| `example/docs/content/rendering.md` | document generator meta + header + how to disable the version |
| `example/docs/content/static-export.md` | note: static output keeps the meta, the header exists only on the brust server |

## Behavior invariants

1. Name is always present on every WELL-FORMED document: every routed page
   whose template/render produces a document head carries the generator meta,
   and every server response carries `X-Powered-By`. Enumerated exclusions
   (meta only — the header still applies): native templates without a
   document/anchor (anchor-missing → no-op, never an error); buffered React
   HTML with no `</head>` (injectCssLink-style warn-once no-op); the
   `onShellError` 500 page (`stream.ts:284` renderToString path bypasses
   injection — header-only by design).
2. The toggle affects ONLY the version substring, in both surfaces, atomically
   (one artifact, one decision).
3. The jinja insert is idempotent in effect: emit always starts from fresh
   compiler output, so re-running build never duplicates the tag.
4. Header insertion must not break the existing header-injection guards
   (CR/LF/NUL) nor override an existing `X-Powered-By` set by user middleware
   headers — user value wins (insert only if absent).
5. SSE/WS upgrade responses and the `/_brust/dev` WS path: header present on
   the upgrade response is fine; no requirement on subsequent frames.
6. Rust change requires `runtime/*.node` rebuild (known trap: stale binary is
   silent).

## Tests

- `runtime/generator.test.ts` (new): string shapes (version on/off, prerelease
  versions), insert anchored after viewport, no-anchor no-op, artifact
  round-trip.
- `runtime/cli/build.test.ts`: `--no-generator-version` parse; emitted jinja
  contains the meta; `generator.json` written to both out dirs; React-only app
  still gets the artifact.
- `runtime/render/stream` test: injection present, dupe guard skips when a
  generator meta already exists.
- `tests/integration.test.ts`: live server — `curl` a native route and a React
  route: meta present in HTML AND `X-Powered-By` present on responses
  (HTML + action/JSON + static asset + cache HIT); version-off build produces
  name-only on both surfaces.
- `runtime/cli/ssg.test.ts`: prerendered HTML contains the meta.
- Rust: unit test in brust-core for the header stamp (present, not duplicated,
  absent `generator` config → no header? NO — fallback strings come from TS,
  so Rust simply stamps whatever string it was given; `None` → no header, which
  only happens for embedders not using the TS runtime).

## Acceptance criteria

1. Fresh `brust build` + boot: every DOCUMENT response of a routed page
   (native, md, React buffered) contains exactly one
   `<meta name="generator" content="brust <version>"/>` (streaming-Suspense
   routes: at least one, fostered into head by the parser), and every
   response of any kind carries `X-Powered-By: brust/<version>`. Error pages
   and anchor-less templates are excluded from the meta criterion (invariant 1).
2. `brust build --no-generator-version`: both surfaces show name-only.
3. `--ssg` output files contain the meta.
4. `brust dev` shows both surfaces too.
5. All existing baselines stay green: `bun run ci`, `bun test runtime/`,
   `tests/integration.test.ts`, cargo fmt/clippy gates, `bun run docs:build`.
6. Docs updated (cli.md, rendering.md, static-export.md) and deployed with the
   normal docs flow on merge.

## Known limitations

- Static hosting (SSG output on CF Pages etc.) has the meta but not the header.
- Upgrading brustjs without rebuilding keeps the OLD baked version string in
  native templates (and in `generator.json`) — accepted consequence of the
  build-time-bake decision.
- Detection by Wappalyzer additionally needs a fingerprint submission to their
  dataset (out of scope; the emitted surfaces match their standard detection
  fields `meta.generator` and `headers.X-Powered-By`).

## Open questions resolved

- **Serve-time vs build-time config** → build-time (user decision; toggling
  requires rebuild).
- **Allow hiding the name** → no (user decision).
- **Header too or meta only** → both (user decision).
- **Where the version comes from** → brustjs `package.json` at build time, never
  the Rust crate version.
- **BrustPage mirror** → unchanged; stream-level injection covers React routes
  and avoids double tags.
- **Param vs internal resolve for the emitters** (spec review blocker) →
  internal resolve from the out dir's `generator.json` with version-on
  fallback; five emit call sites stay untouched and every re-emit is
  self-consistent.
- **Streaming-Suspense placement** (spec review blocker) → prepend with the
  first-chunk tags before `<!DOCTYPE>`; parser fosters into head; no dupe
  guard there (documented limitation).
- **onShellError 500 page** → header-only; no meta.
- **Old artifact after brustjs upgrade without rebuild** → serve-time fallback
  only fires when the artifact is MISSING; an existing artifact (even stale)
  wins, matching the baked templates.
