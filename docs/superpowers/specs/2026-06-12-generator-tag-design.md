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
        ├─ (a) native + md jinja templates: literal insert of the meta tag
        │      right after the compiler-emitted viewport meta, applied to the
        │      compileJsx output before it is written to disk — covers BOTH
        │      emit paths (runtime/cli/native-routes-emit.ts and
        │      runtime/md/emit.ts) and BOTH dual-emit locations
        │      (dist/jinja and .brust/jinja).
        │
        ├─ (b) generator.json artifact written into every jinja out dir
        │      (created even for React-only apps with zero native routes):
        │      { "meta": "<full meta tag>", "header": "brust/x.y.z" }
        │
        └─ (c) consumed at serve time:
               • React streaming: runtime/render/stream.ts injects the meta
                 tag into <head> at the same point as injectCssLink, via a
                 configured singleton (runtime/render/generator.ts) seeded
                 from <jinjaDir>/generator.json by BOTH the main isolate and
                 the worker isolates (mirror of configureCssHrefsForRoute —
                 the worker-not-configured trap is known and load-bearing).
               • X-Powered-By: runtime/index.ts serve() reads the same
                 artifact and threads `generator` (camelCase!) through napi
                 ServeOptions (crates/brust/src/lib.rs) into brust-core
                 server state; a single insertion point at the hyper
                 service layer (crates/brust-core/src/server/mod.rs,
                 service_fn wrapper around handle_request) stamps the header
                 on every response, including cache HITs.
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

### React-path duplicate guard

`stream.ts` skips injection when the buffered head already contains
`name="generator"` (cheap substring check) so a hand-authored generator meta
(e.g. via `BrustPage head={[…]}`) wins and no duplicate is emitted. The same
guard is NOT needed on the jinja path: the insert runs once at emit time on
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
| `runtime/generator.ts` (new) | `generatorStrings(versionOn: boolean)` + `insertGeneratorMeta(jinja, metaTag)` + artifact read/write helpers + version read (help.ts pattern) |
| `runtime/cli/build.ts` | parse `--no-generator-version`; apply insert to emitted jinja; write `generator.json` to all jinja out dirs (dual-emit); always write even for React-only apps |
| `runtime/cli/dev.ts` | same flag; same insert + artifact in the dev pipeline |
| `runtime/cli/native-routes-emit.ts` | accept the resolved meta tag (param) and insert after compileJsx, before the jinja write |
| `runtime/md/emit.ts` | same insert on the md wrapper-compile path |
| `runtime/render/generator.ts` (new) | configured singleton: `configureGenerator(meta: string \| null)` / `getGeneratorMeta()` |
| `runtime/render/stream.ts` | inject meta next to `injectCssLink` (with dupe guard) |
| `runtime/index.ts` | main + worker boot: read artifact, seed the singleton, thread `generator` header string into napi ServeOptions |
| `crates/brust/src/lib.rs` | `ServeOptions.generator: Option<String>` (napi camelCases it — JS passes `generator`); validate single-line ASCII; store in server state |
| `crates/brust-core/src/server/mod.rs` | stamp `X-Powered-By` once at the service layer for every response |
| `example/docs/content/cli.md` | document the flag |
| `example/docs/content/rendering.md` | document generator meta + header + how to disable the version |
| `example/docs/content/static-export.md` | note: static output keeps the meta, the header exists only on the brust server |

## Behavior invariants

1. Name is always present; no code path produces HTML without the generator
   meta or a server response without `X-Powered-By` (modulo invariant 5).
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

1. Fresh `brust build` + boot: every HTML response contains exactly one
   `<meta name="generator" content="brust <version>"/>` and every response
   carries `X-Powered-By: brust/<version>`.
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
