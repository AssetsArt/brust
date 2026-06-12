# Generator tag + X-Powered-By Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every brust-built site carries `<meta name="generator" content="brust <version>"/>` in HTML and `X-Powered-By: brust/<version>` on server responses; `--no-generator-version` (build/dev) drops the version (name not disableable), baked at build time.

**Architecture:** One decision artifact `generator.json` written by build/dev into the jinja out dirs; emitters resolve it internally (version-on fallback) and bake the meta into native/md jinja; React streaming injects at render time from the same artifact; the header threads through napi ServeOptions and is stamped once in the hyper service wrapper. Spec: `docs/superpowers/specs/2026-06-12-generator-tag-design.md` (read it first — invariants + exclusions live there).

**Tech Stack:** Bun + TypeScript (runtime/), Rust (crates/brust napi + crates/brust-core hyper server), bun:test, cargo test.

**Ground rules (repo-specific):**
- TS lint gate is `bun run ci` (biome). NEVER run bare `tsc` (stack-overflows).
- After ANY Rust change: `cd runtime && bun run build` or every later test silently uses the stale `.node` binary.
- Cargo gates: `cargo fmt --all --check` and `cargo clippy --workspace --all-targets --locked -- -D warnings`.
- Run from repo root `/Users/detoro/code/brust` unless stated.

---

### Task 1: `runtime/generator.ts` — strings, insert, artifact

**Files:**
- Create: `runtime/generator.ts`
- Test: `runtime/generator.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// runtime/generator.test.ts
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  generatorStrings,
  insertGeneratorMeta,
  readGeneratorArtifact,
  resolveGenerator,
  writeGeneratorArtifact,
} from './generator.ts'

const VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1"/>'

describe('generatorStrings', () => {
  test('version on: meta + header carry the brustjs package version', () => {
    const g = generatorStrings(true)
    // version comes from <root>/package.json — assert shape, not the literal
    expect(g.meta).toMatch(/^<meta name="generator" content="brust [0-9A-Za-z.+-]+"\/>$/)
    expect(g.header).toMatch(/^brust\/[0-9A-Za-z.+-]+$/)
  })
  test('version off: name only', () => {
    const g = generatorStrings(false)
    expect(g.meta).toBe('<meta name="generator" content="brust"/>')
    expect(g.header).toBe('brust')
  })
})

describe('insertGeneratorMeta', () => {
  const TAG = '<meta name="generator" content="brust 9.9.9"/>'
  test('inserts immediately after the viewport anchor', () => {
    const jinja = `<html><head><meta charset="utf-8"/>${VIEWPORT}<title>x</title></head></html>`
    const out = insertGeneratorMeta(jinja, TAG)
    expect(out).toBe(
      `<html><head><meta charset="utf-8"/>${VIEWPORT}${TAG}<title>x</title></head></html>`,
    )
  })
  test('no anchor → no-op, never throws', () => {
    expect(insertGeneratorMeta('<div>fragment</div>', TAG)).toBe('<div>fragment</div>')
  })
  test('only the FIRST anchor is used', () => {
    const jinja = `${VIEWPORT}${VIEWPORT}`
    const out = insertGeneratorMeta(jinja, TAG)
    expect(out).toBe(`${VIEWPORT}${TAG}${VIEWPORT}`)
  })
})

describe('artifact round-trip', () => {
  test('write → read returns the same strings; resolve falls back when missing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'brust-gen-'))
    const g = generatorStrings(false)
    writeGeneratorArtifact(dir, g)
    expect(readGeneratorArtifact(dir)).toEqual(g)
    expect(resolveGenerator(dir)).toEqual(g)
    // missing dir → null artifact → version-on fallback
    const missing = path.join(dir, 'nope')
    expect(readGeneratorArtifact(missing)).toBeNull()
    expect(resolveGenerator(missing)).toEqual(generatorStrings(true))
  })
  test('malformed artifact → null → fallback', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'brust-gen-'))
    writeFileSync(path.join(dir, 'generator.json'), '{"meta": 7}')
    expect(readGeneratorArtifact(dir)).toBeNull()
    expect(resolveGenerator(dir)).toEqual(generatorStrings(true))
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test runtime/generator.test.ts`
Expected: FAIL — `Cannot find module './generator.ts'`

- [ ] **Step 3: Write the implementation**

```ts
// runtime/generator.ts
// Generator-tag decision module. ONE resolved decision { meta, header } made at
// build time (brust build / brust dev write generator.json into every jinja out
// dir); consumed by the jinja emitters (bake), the React stream injector, and
// the X-Powered-By napi thread. The name "brust" is mandatory; only the version
// substring is optional (--no-generator-version). Spec:
// docs/superpowers/specs/2026-06-12-generator-tag-design.md
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { readVersion } from './cli/help.ts'

export interface GeneratorStrings {
  /** Full meta tag, e.g. `<meta name="generator" content="brust 0.1.48-alpha"/>` */
  meta: string
  /** X-Powered-By value, e.g. `brust/0.1.48-alpha` */
  header: string
}

/** Build the resolved strings. Version comes from the brustjs package.json
 * (readVersion never throws — "unknown" degrades to name-only, never a crash).
 * The version is sanitized to attr/header-safe bytes; semver chars only. */
export function generatorStrings(versionOn: boolean): GeneratorStrings {
  const raw = readVersion()
  const v = raw === 'unknown' ? '' : raw.replace(/[^0-9A-Za-z.+-]/g, '')
  const withVersion = versionOn && v.length > 0
  return {
    meta: `<meta name="generator" content="brust${withVersion ? ` ${v}` : ''}"/>`,
    header: withVersion ? `brust/${v}` : 'brust',
  }
}

/** The exact head literal the Rust compiler emits for every Document template
 * (crates/jsx-rust-compiler/src/emit_jinja.rs:110). Compiler-owned and stable. */
const VIEWPORT_ANCHOR = '<meta name="viewport" content="width=device-width, initial-scale=1"/>'

/** Insert the generator meta immediately after the compiler-emitted viewport
 * meta. Anchor missing (non-document template) → no-op, never an error. Emit
 * always starts from fresh compiler output, so re-running never duplicates. */
export function insertGeneratorMeta(jinja: string, metaTag: string): string {
  const at = jinja.indexOf(VIEWPORT_ANCHOR)
  if (at === -1) return jinja
  const end = at + VIEWPORT_ANCHOR.length
  return jinja.slice(0, end) + metaTag + jinja.slice(end)
}

/** Write the decision artifact into `dir` (a jinja out dir), creating it. */
export function writeGeneratorArtifact(dir: string, strings: GeneratorStrings): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'generator.json'), JSON.stringify(strings))
}

/** Read the artifact; null on missing/malformed (caller decides the fallback). */
export function readGeneratorArtifact(dir: string): GeneratorStrings | null {
  try {
    const raw = readFileSync(path.join(dir, 'generator.json'), 'utf8')
    const p = JSON.parse(raw) as Partial<GeneratorStrings>
    if (typeof p.meta === 'string' && typeof p.header === 'string') {
      return { meta: p.meta, header: p.header }
    }
    return null
  } catch {
    return null
  }
}

/** Artifact if present, else version-on defaults — the spec's fallback policy
 * (an old dist with no artifact behaves as default = version on). */
export function resolveGenerator(dir: string): GeneratorStrings {
  return readGeneratorArtifact(dir) ?? generatorStrings(true)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test runtime/generator.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Lint + commit**

```bash
bun run ci
git add runtime/generator.ts runtime/generator.test.ts
git commit -m "feat(generator): strings + jinja insert + decision artifact module"
```

---

### Task 2: `brust build` — flag + artifact write

**Files:**
- Modify: `runtime/cli/build.ts` (ParsedArgs ~:142-218, runBuild — write artifact before the emit; find the `emitNativeTemplates(`/`emitMdArtifacts(` calls and the `.brust/jinja` dual-emit copy at ~:478)
- Test: `runtime/cli/build.test.ts` (parseArgs cases exist there already — follow their shape)

- [ ] **Step 1: Write the failing tests** (add to the existing parseArgs describe block in `runtime/cli/build.test.ts`)

```ts
test('--no-generator-version sets generatorVersion false', () => {
  const p = parseArgs(['--no-generator-version'])
  expect(p.generatorVersion).toBe(false)
})

test('generatorVersion defaults to true', () => {
  const p = parseArgs([])
  expect(p.generatorVersion).toBe(true)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test runtime/cli/build.test.ts -t 'generator'`
Expected: FAIL — `generatorVersion` undefined / unknown flag thrown

- [ ] **Step 3: Implement**

In `ParsedArgs` add:

```ts
  generatorVersion: boolean // false ⇔ --no-generator-version (name-only generator tag)
```

In `parseArgs`, alongside the `--ssg` branch:

```ts
    } else if (a === '--no-generator-version') {
      generatorVersion = false
```

with `let generatorVersion = true` declared next to `let ssg = false`, and `generatorVersion` added to the return object.

In `runBuild`, BEFORE the native/md emit calls (both emit into the jinja out dir — locate the `emitNativeTemplates({ ... outDir: ... })` call and use the SAME jinja dir variable), write the artifact to BOTH dual-emit locations explicitly (do NOT rely on the post-emit copy at ~:478 — it may glob only `*.jinja`):

```ts
  const { generatorStrings, writeGeneratorArtifact } = await import('../generator.ts')
  const gen = generatorStrings(parsed.generatorVersion)
  writeGeneratorArtifact(distJinjaDir, gen) // <outDir>/jinja — adapt to the local variable name
  writeGeneratorArtifact(path.resolve(process.cwd(), '.brust/jinja'), gen)
```

IMPORTANT: this must run even when the app has ZERO native/md routes (React-only apps still need the artifact for the stream injector + header) — place it before any `if (nativeRoutes.length)` guard.

- [ ] **Step 4: Run tests**

Run: `bun test runtime/cli/build.test.ts`
Expected: PASS (all existing + 2 new)

- [ ] **Step 5: Lint + commit**

```bash
bun run ci
git add runtime/cli/build.ts runtime/cli/build.test.ts
git commit -m "feat(generator): brust build --no-generator-version + generator.json artifact"
```

---

### Task 3: bake the meta into native + md jinja emit

**Files:**
- Modify: `runtime/cli/native-routes-emit.ts` (~:634-637, the `withDirectives` → `template` → `writeFileSync(outPath, template)` block)
- Modify: `runtime/md/emit.ts` (~:331-338, `spliceMdSlot` → `writeFileSync(outPath, template)`)
- Test: `runtime/cli/build.test.ts` or the existing emit-level test file for md (`runtime/md/emit.test.ts`) — assert emitted jinja contains the tag

- [ ] **Step 1: Write the failing assertions**

In `runtime/md/emit.test.ts`, find an existing test that reads an emitted `.jinja` and add (or add a focused test using its fixture helpers):

```ts
expect(emitted).toContain('<meta name="generator" content="brust')
```

For the native path, the cheapest real coverage is the existing build/emit fixture test that asserts on emitted jinja content (`runtime/cli/build.test.ts` or `tests/` cli-build suite). Add the same `toContain` assertion next to an existing emitted-template content assertion. If no such content assertion exists in fast tests, add it in Task 7's integration step instead and note it here as covered-later.

- [ ] **Step 2: Run to verify failure**

Run: `bun test runtime/md/emit.test.ts`
Expected: the new assertion FAILS (no generator meta yet)

- [ ] **Step 3: Implement — native emitter**

In `runtime/cli/native-routes-emit.ts`, import at top:

```ts
import { insertGeneratorMeta, resolveGenerator } from '../generator.ts'
```

Inside `emitNativeTemplates`, BEFORE the `for (const r of nativeRoutes)` loop (~:531), resolve once:

```ts
  // Generator meta: resolved INTERNALLY from the out dir's artifact (NOT a
  // caller param) — emit re-runs from five call sites (build, dev, boot
  // staleness, md boot re-emit, dev HMR) and a param would silently drop the
  // tag on re-emit. Fallback (no artifact) = version-on defaults.
  const generatorMeta = resolveGenerator(opts.outDir).meta
```

Then change the write block at ~:634-637 from:

```ts
    const withDirectives = bakeDirectivesIfUsed(compiled.template, hasDirectives)
    const template =
      process.env.BRUST_DEV === '1' ? injectDevClientIntoTemplate(withDirectives) : withDirectives
    writeFileSync(outPath, template)
```

to:

```ts
    const withDirectives = bakeDirectivesIfUsed(compiled.template, hasDirectives)
    const withGenerator = insertGeneratorMeta(withDirectives, generatorMeta)
    const template =
      process.env.BRUST_DEV === '1' ? injectDevClientIntoTemplate(withGenerator) : withGenerator
    writeFileSync(outPath, template)
```

- [ ] **Step 4: Implement — md emitter**

In `runtime/md/emit.ts`, same import (path is `../generator.ts` from `runtime/md/`). Resolve once before the route loop (same comment), then change ~:331-338 from:

```ts
    const template = spliceMdSlot(compiled.template, name, mdHtml)
```

to:

```ts
    const template = insertGeneratorMeta(spliceMdSlot(compiled.template, name, mdHtml), generatorMeta)
```

(The insert anchors on the head viewport literal; md renumbering/behavior splice touch only the body — no interaction. `countMainTags` below is unaffected.)

- [ ] **Step 5: Run tests**

Run: `bun test runtime/md/ runtime/cli/build.test.ts runtime/generator.test.ts`
Expected: PASS including the new assertions

- [ ] **Step 6: Lint + commit**

```bash
bun run ci
git add runtime/cli/native-routes-emit.ts runtime/md/emit.ts runtime/md/emit.test.ts runtime/cli/build.test.ts
git commit -m "feat(generator): bake generator meta into native + md jinja emit"
```

---

### Task 4: `brust dev` — flag + artifact before first emit

**Files:**
- Modify: `runtime/cli/dev.ts` (`ParsedArgs` + `parseArgs` ~:10-54, `runDev` ~:56-80)

- [ ] **Step 1: Implement** (dev.ts's parseArgs uses console.error + process.exit — no pure-parse unit test exists for it; coverage comes from the emit path tests + Task 7)

Add to dev's `ParsedArgs`: `generatorVersion: boolean`. In `parseArgs`, next to the `--port` branch:

```ts
    } else if (a === '--no-generator-version') {
      generatorVersion = false
```

(with `let generatorVersion = true` and returned.)

In `runDev`, right after `process.env.BRUST_DEV = '1'` (~:58):

```ts
  // Bake the generator decision BEFORE the first emit — emitters and the boot
  // re-emit paths all resolve <cwd>/.brust/jinja/generator.json internally.
  const { generatorStrings, writeGeneratorArtifact } = await import('../generator.ts')
  writeGeneratorArtifact(
    path.resolve(process.cwd(), '.brust/jinja'),
    generatorStrings(generatorVersion),
  )
```

- [ ] **Step 2: Verify + commit**

Run: `bun test runtime/cli/ && bun run ci`
Expected: PASS, clean

```bash
git add runtime/cli/dev.ts
git commit -m "feat(generator): brust dev --no-generator-version + artifact before emit"
```

---

### Task 5: React stream injection (buffered + streaming branches)

**Files:**
- Create: `runtime/render/inject-generator.ts`
- Test: `runtime/render/inject-generator.test.ts`
- Modify: `runtime/render/stream.ts` (buffered `final` ~:173-180; streaming branch prepend ~:235-254)
- Modify: `runtime/index.ts` (main: after `configureJinjaDir(jinjaDir)` at ~:634; worker: after `configureJinjaDir(workerJinjaDir)` at ~:973)

- [ ] **Step 1: Write the failing tests**

```ts
// runtime/render/inject-generator.test.ts
import { describe, expect, test } from 'bun:test'
import { injectGeneratorMeta } from './inject-generator.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const TAG = '<meta name="generator" content="brust 9.9.9"/>'
const body = (s: string) => ENC.encode(s)

describe('injectGeneratorMeta', () => {
  test('inserts before </head>', () => {
    const out = injectGeneratorMeta(body('<html><head><title>x</title></head><body></body></html>'), TAG)
    expect(DEC.decode(out)).toBe(
      `<html><head><title>x</title>${TAG}</head><body></body></html>`,
    )
  })
  test('null/empty tag → untouched', () => {
    const src = body('<head></head>')
    expect(injectGeneratorMeta(src, null)).toBe(src)
    expect(injectGeneratorMeta(src, '')).toBe(src)
  })
  test('no </head> → untouched', () => {
    const src = body('<div>chunk</div>')
    expect(injectGeneratorMeta(src, TAG)).toBe(src)
  })
  test('dupe guard: existing generator meta wins', () => {
    const src = body('<head><meta name="generator" content="custom"/></head>')
    expect(injectGeneratorMeta(src, TAG)).toBe(src)
  })
  test('multibyte content before </head> keeps byte alignment', () => {
    const out = injectGeneratorMeta(body('<head><title>สวัสดี</title></head>'), TAG)
    expect(DEC.decode(out)).toBe(`<head><title>สวัสดี</title>${TAG}</head>`)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test runtime/render/inject-generator.test.ts`
Expected: FAIL — module missing

- [ ] **Step 3: Implement the module**

```ts
// runtime/render/inject-generator.ts
// Render-time generator-meta injection for React-streamed HTML. The tag value
// comes from the build's generator.json (configured at boot by BOTH the main
// and worker isolates — module state is per-isolate, same trap as
// configureJinjaDir). Buffered branch: splice before </head> with a duplicate
// guard (a hand-authored generator meta wins). Streaming branch (stream.ts)
// prepends the raw tag with the other first-chunk tags instead — no guard
// possible there (head bytes arrive in later chunks); documented limitation.
const ENC = new TextEncoder()

let configured: string | null = null

/** Seed from generator.json at boot (main + worker). null → no injection. */
export function configureGeneratorMeta(meta: string | null): void {
  configured = meta
}

export function getGeneratorMeta(): string | null {
  return configured
}

const GUARD = ENC.encode('name="generator"')

/** Splice `metaTag` immediately before the first `</head>` (case-insensitive).
 * No </head> in the chunk, empty tag, or an existing generator meta → body
 * returned untouched. Byte-level (no decode) — safe with multibyte content. */
export function injectGeneratorMeta(body: Uint8Array, metaTag: string | null): Uint8Array {
  if (!metaTag) return body
  const pos = findHeadCloseTag(body)
  if (pos < 0) return body
  if (bytesInclude(body, GUARD, pos)) return body
  const tagBytes = ENC.encode(metaTag)
  const out = new Uint8Array(body.length + tagBytes.length)
  out.set(body.subarray(0, pos), 0)
  out.set(tagBytes, pos)
  out.set(body.subarray(pos), pos + tagBytes.length)
  return out
}

/** True if `needle` occurs in `hay[0..limit)`. Naive scan — head is small. */
function bytesInclude(hay: Uint8Array, needle: Uint8Array, limit: number): boolean {
  const max = Math.min(limit, hay.length) - needle.length
  outer: for (let i = 0; i <= max; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer
    }
    return true
  }
  return false
}

/** Byte scan for `</head>` (letters case-insensitive) — same approach as
 * inject-css-link.ts. Returns offset of `<` or -1. */
function findHeadCloseTag(body: Uint8Array): number {
  const LT = 0x3c
  const SL = 0x2f
  const GT = 0x3e
  for (let i = 0, max = body.length - 6; i < max; i++) {
    if (body[i] !== LT || body[i + 1] !== SL) continue
    if (!isLetter(body[i + 2], 0x48)) continue // H
    if (!isLetter(body[i + 3], 0x45)) continue // E
    if (!isLetter(body[i + 4], 0x41)) continue // A
    if (!isLetter(body[i + 5], 0x44)) continue // D
    if (body[i + 6] !== GT) continue
    return i
  }
  return -1
}

function isLetter(b: number, u: number): boolean {
  return b === u || b === (u | 0x20)
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test runtime/render/inject-generator.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Wire into stream.ts**

Import at top of `runtime/render/stream.ts` (next to the other inject imports ~:9-14):

```ts
import { getGeneratorMeta, injectGeneratorMeta } from './inject-generator.ts'
```

Buffered branch — after the `injectCssLink` line (~:177):

```ts
            body = injectCssLink(body, [...getCssHrefs(), ...perRouteHrefs])
            body = injectGeneratorMeta(body, getGeneratorMeta())
```

Streaming branch — extend the prepend block (~:240-249). Add with the other tag strings:

```ts
            const devTag = getDevClientSnippet() ?? ''
            const prefixTag = getActionPrefixSnippet() ?? ''
            const storeTag = buildStoreScripts(args.storeSnapshot ?? null)
            const genTag = getGeneratorMeta() ?? ''
```

and change the condition + concat to include it (generator FIRST so detectors see it early):

```ts
            if (
              linkTagsStr.length > 0 ||
              devTag.length > 0 ||
              prefixTag.length > 0 ||
              storeTag.length > 0 ||
              genTag.length > 0
            ) {
              const prepend = encoder.encode(genTag + linkTagsStr + prefixTag + devTag + storeTag)
```

- [ ] **Step 6: Seed at boot — runtime/index.ts**

Main isolate, immediately after `configureJinjaDir(jinjaDir)` (~:634):

```ts
      configureJinjaDir(jinjaDir)
      const { resolveGenerator } = await import('./generator.ts')
      const gen = resolveGenerator(jinjaDir)
      resolvedGeneratorStrings = gen
      const { configureGeneratorMeta } = await import('./render/inject-generator.ts')
      configureGeneratorMeta(gen.meta)
```

Worker isolate, immediately after `configureJinjaDir(workerJinjaDir)` (~:973):

```ts
      configureJinjaDir(workerJinjaDir)
      {
        const { resolveGenerator } = await import('./generator.ts')
        const { configureGeneratorMeta } = await import('./render/inject-generator.ts')
        configureGeneratorMeta(resolveGenerator(workerJinjaDir).meta)
      }
```

And add the module-level stash near the top of `runtime/index.ts` (used by Task 6's serve threading):

```ts
// Resolved generator strings, set by the main-isolate view boot (which runs
// before serve() binds the listener). serve() falls back to resolving the
// artifact itself when boot hasn't stashed one (defensive — ordering holds in
// every real entry: view registration precedes serve).
let resolvedGeneratorStrings: import('./generator.ts').GeneratorStrings | null = null
```

- [ ] **Step 7: Test + lint + commit**

Run: `bun test runtime/render/ && bun run ci`
Expected: PASS, clean

```bash
git add runtime/render/inject-generator.ts runtime/render/inject-generator.test.ts runtime/render/stream.ts runtime/index.ts
git commit -m "feat(generator): React stream injection (buffered splice + streaming prepend) + boot seeding"
```

---

### Task 6: X-Powered-By — napi field + Rust stamp + serve threading

**Files:**
- Modify: `crates/brust/src/lib.rs` (ServeOptions ~:46-69; begin_serve validation ~:166-173)
- Modify: `crates/brust-core/src/config.rs` (AppState field ~:84/:123; setter/getter ~:259-266 — mirror `action_prefix`)
- Modify: `crates/brust-core/src/server/mod.rs` (service closure ~:225-234)
- Modify: `runtime/index.ts` (`serve()` beginServe call ~:149-159)
- Test: Rust unit in `crates/brust-core` (config get/set; header stamp covered e2e in Task 7)

- [ ] **Step 1: AppState storage (config.rs)** — mirror the `action_prefix` pattern exactly:

Field (next to `action_prefix: RwLock<String>` ~:84):

```rust
    /// `X-Powered-By` value (e.g. `brust/0.1.48-alpha`). None → header not
    /// stamped (embedders not using the TS runtime). Set once at begin_serve.
    pub(crate) generator: RwLock<Option<String>>,
```

Init (~:123): `generator: RwLock::new(None),`

Methods (next to `set_action_prefix` ~:259):

```rust
    pub fn set_generator(&self, value: String) {
        *self.generator.write() = Some(value);
    }

    pub fn generator(&self) -> Option<String> {
        self.generator.read().clone()
    }
```

Unit test in the same file's test module (or config tests):

```rust
    #[test]
    fn generator_default_none_set_get() {
        let s = AppState::new();
        assert_eq!(s.generator(), None);
        s.set_generator("brust/1.2.3".to_string());
        assert_eq!(s.generator(), Some("brust/1.2.3".to_string()));
    }
```

- [ ] **Step 2: Stamp in the service wrapper (server/mod.rs ~:225-234)**

Compute the header value ONCE before the accept loop spawns connections (where `state` is already in scope before the `loop`/spawn — place next to the other pre-loop derivations):

```rust
    // X-Powered-By, stamped on EVERY response at the service layer (render,
    // action, static, cache HIT, SAB fast-lane, streaming, WS 101 — all return
    // through handle_request). insert-if-absent: user middleware headers win.
    // Cached framed bytes are captured pre-stamp inside dispatch, so stamping
    // HITs here can never duplicate.
    let powered_by: Option<http::HeaderValue> = state
        .generator()
        .and_then(|s| http::HeaderValue::from_str(&s).ok());
```

Then change the closure at ~:234 from:

```rust
                    let svc = service_fn(move |req| handle_request(req, Arc::clone(&state)));
```

to:

```rust
                    let powered_by = powered_by.clone();
                    let svc = service_fn(move |req| {
                        let state = Arc::clone(&state);
                        let powered_by = powered_by.clone();
                        async move {
                            let mut resp = handle_request(req, state).await?;
                            if let Some(v) = powered_by {
                                resp.headers_mut()
                                    .entry(http::header::HeaderName::from_static("x-powered-by"))
                                    .or_insert(v);
                            }
                            Ok(resp)
                        }
                    });
```

(`powered_by` must ALSO be cloned into the outer per-connection `tokio::spawn` move closure — add `let powered_by = powered_by.clone();` next to `let state = Arc::clone(&state);` at ~:225. The compiler will tell you; the return type of the async block must match what `serve_io` expects — keep `Result` plumbing identical to `handle_request`'s signature.)

- [ ] **Step 3: napi surface (crates/brust/src/lib.rs)**

ServeOptions field (after `action_prefix` ~:57):

```rust
    /// `X-Powered-By` header value (e.g. `brust/0.1.48-alpha`). Single-line
    /// ASCII; omit to skip the header. The TS runtime always passes it (name
    /// mandatory, version per the build's generator.json).
    pub generator: Option<String>,
```

In `begin_serve` (next to the action_prefix validation ~:166):

```rust
    if let Some(g) = &opts.generator {
        let g = g.trim();
        if g.is_empty() || !g.bytes().all(|b| b.is_ascii_graphic() || b == b' ') {
            return Err(napi::Error::from_reason(format!(
                "generator must be non-empty single-line printable ASCII: {g:?}"
            )));
        }
        state().set_generator(g.to_string());
    }
```

- [ ] **Step 4: Thread from TS (runtime/index.ts serve() ~:149-159)**

```ts
    const { resolveGenerator } = await import('./generator.ts')
    const gen =
      resolvedGeneratorStrings ?? resolveGenerator(path.resolve(process.cwd(), '.brust/jinja'))
    ;(native as any).beginServe({
      host: opts.host,
      port: opts.port,
      workers: opts.workers,
      entry: opts.entry,
      tuning: opts.tuning,
      actionPrefix: opts.actionPrefix,
      // X-Powered-By value from the build's generator.json (stashed by view
      // boot; artifact fallback covers any ordering edge). Single word — no
      // napi case-mapping trap possible.
      generator: gen.header,
    })
```

(`serve` may need to become/stay async — it already is. Check whether `path` is imported in that scope; it is used elsewhere in index.ts.)

- [ ] **Step 5: Rust gates + rebuild the napi binary (MANDATORY)**

```bash
cargo test -p brust-core
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cd runtime && bun run build && cd ..
```

Expected: tests pass, fmt/clippy clean, fresh `runtime/*.node`.

- [ ] **Step 6: TS tests still green + commit**

```bash
bun test runtime/ && bun run ci
git add crates/ runtime/index.ts
git commit -m "feat(generator): X-Powered-By header — napi generator option + hyper service stamp"
```

---

### Task 7: integration + ssg coverage

**Files:**
- Modify: `tests/integration.test.ts` (live-server suite — follow existing curl/fetch test shapes there)
- Modify: `runtime/cli/ssg.test.ts` (add assertions to an EXISTING prerender test — do not add a new boot, the suite is slow)

- [ ] **Step 1: Add integration assertions** (failing first — run before implementing nothing new; they should PASS already if Tasks 1-6 landed; treat a failure as a real wiring bug, not a test bug)

In `tests/integration.test.ts`, inside the existing booted-server describe, add:

```ts
test('generator: meta tag present on native and React documents', async () => {
  for (const p of ['/native-route-path', '/react-route-path']) { // use two real fixture routes from this suite
    const res = await fetch(`${base}${p}`)
    const html = await res.text()
    const hits = html.match(/<meta name="generator" content="brust [0-9A-Za-z.+-]+"\/>/g) ?? []
    expect(hits.length).toBe(1)
  }
})

test('generator: X-Powered-By on every response kind', async () => {
  const expected = /^brust\/[0-9A-Za-z.+-]+$/
  for (const p of ['/native-route-path', '/_brust/css/app.css']) {
    const res = await fetch(`${base}${p}`)
    expect(res.headers.get('x-powered-by') ?? '').toMatch(expected)
  }
})
```

(Adapt `base` + route paths to the suite's existing constants. If the suite asserts exact header sets anywhere, update those expectations.)

- [ ] **Step 2: ssg assertion** — in `runtime/cli/ssg.test.ts`, find an existing test that reads a prerendered HTML file and add:

```ts
expect(prerenderedHtml).toContain('<meta name="generator" content="brust')
```

- [ ] **Step 3: Run both suites**

```bash
bun test tests/integration.test.ts
bun test runtime/cli/ssg.test.ts   # slow ~3-4 min, boots fixture dist
```

Expected: PASS. If the integration meta count is 0 for the React fixture route: check whether the fixture's layout emits `</head>` (spec exclusion) before debugging the injector.

- [ ] **Step 4: Commit**

```bash
git add tests/integration.test.ts runtime/cli/ssg.test.ts
git commit -m "test(generator): integration meta+header coverage + ssg prerender assertion"
```

---

### Task 8: docs

**Files:**
- Modify: `example/docs/content/cli.md` (build flags table ~:36-56; dev flags table ~:66-69)
- Modify: `example/docs/content/rendering.md` (new section before `## Which mode, when` ~:128)
- Modify: `example/docs/content/static-export.md` (Hosting section ~:165)

- [ ] **Step 1: cli.md** — add to the `brust build` flags table:

```md
| `--no-generator-version` | Drop the version from the generator tag + `X-Powered-By` header (name `brust` always stays) |
```

same row in the `brust dev` flags table, and under "Notes on the flags":

```md
- brust identifies itself with `<meta name="generator" content="brust <version>">` and an `X-Powered-By: brust/<version>` header. `--no-generator-version` keeps the name but drops the version — the decision is baked at build time, so flipping it requires a rebuild. See [Rendering](/docs/rendering) for details.
```

- [ ] **Step 2: rendering.md** — insert before `## Which mode, when`:

```md
## Generator tag

Every brust-rendered document carries a generator meta tag, and every response
from the brust server carries an `X-Powered-By` header — this is how technology
detectors like Wappalyzer identify brust sites:

```html
<meta name="generator" content="brust 0.1.48-alpha"/>
```

```http
X-Powered-By: brust/0.1.48-alpha
```

The tag is baked into native and Markdown templates at build time and injected
into React-streamed HTML at render time. Static export (`brust build --ssg`)
inherits the meta tag in every prerendered file.

Prefer not to advertise your framework version? Build with
`--no-generator-version` to keep the name but drop the version (the name is
always present). The decision is baked at build time — flipping it requires a
rebuild. If you hand-author your own `<meta name="generator" …>` on a buffered
route, yours wins and brust does not add a second one.
```

- [ ] **Step 3: static-export.md** — add to the Hosting section:

```md
Prerendered files include the `<meta name="generator" content="brust …">` tag,
but the `X-Powered-By` header exists only when the brust server serves the
response — static hosts won't send it.
```

- [ ] **Step 4: Verify docs build + commit**

```bash
bun run docs:build
git add example/docs/content/cli.md example/docs/content/rendering.md example/docs/content/static-export.md
git commit -m "docs: generator tag + X-Powered-By + --no-generator-version"
```

Expected: docs build green (20 pages + 20 spa payloads, baseline from handoff).

---

## BLOCKED fallbacks

- **Task 5 ordering (serve() before view boot):** if the integration test shows the header/meta missing because `resolvedGeneratorStrings` is null at serve time AND the cwd fallback misses (custom out dir), pivot: detect the dist dir in serve() the same way the boot code computes `prebuilt`/`distDir` (read that logic in index.ts ~:560-594) and resolve from `<distDir>/jinja`. Do not move beginServe.
- **Task 6 closure type friction:** if the `service_fn` async-block wrapper fights hyper's trait bounds, fall back to stamping at the END of `handle_request` itself (single `let mut resp = …; stamp; resp` wrapper INSIDE that fn around its match — still one choke point, slightly less elegant). Document the deviation in the commit message.
- **Task 7 fixture routes:** if the integration fixture has no pure-React document route with `</head>`, assert the native route + an action/JSON response header only, and note the gap in the PR description.
- **Full-fixture --ssg crawl** can never pass (auth 401 by design — handoff note); do NOT try to make it.

## Self-review (done at plan-write time)

- Spec coverage: strings/insert/artifact → T1; flag+artifact build → T2; native+md bake (5 call sites via internal resolve) → T3; dev → T4; stream both branches + boot seeding (worker trap) → T5; napi+Rust stamp+threading → T6; AC1-AC4 evidence → T7; docs → T8. Fallback policy → T1 resolveGenerator + T5/T6 consumers. BrustPage mirror: intentionally untouched (spec).
- Placeholders: none — full code in every code step; T3's native-content assertion explicitly deferred-to-T7 if no fast hook exists.
- Type consistency: `GeneratorStrings{meta,header}` used across T1/T2/T5/T6; `generatorVersion: boolean` in both CLIs; `configureGeneratorMeta`/`getGeneratorMeta`/`injectGeneratorMeta` names match between T5 module and stream.ts wiring.
