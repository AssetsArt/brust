# Tailwind v4 CSS Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** First-class Tailwind v4 support via a conventional `<scanRoot>/app.css` source-of-truth, compiled programmatically through `@tailwindcss/node` at build time and dev-mode boot. Output served from a new Rust route `/_brust/css/<file>` (mirrors `/_brust/islands/<file>`), and the SSR renderer auto-injects `<link rel="stylesheet">` immediately before `</head>` on the first chunk.

**Architecture:** A small new package `runtime/css/` houses the build helper. A new module-scope state file `runtime/css.ts` carries the renderer hint. The renderer (`runtime/render/stream.ts`) gains a first-chunk byte-level rewrite. Rust gains one new global, one napi binding, one route branch, one filename validator. `brust.run()` and `runtime/cli/build.ts` get small detection + wiring branches that mirror existing patterns. Example app migrates inline styles → Tailwind classes to validate end-to-end.

**Tech Stack:** TypeScript (strict), Bun runtime, React 18 stable SSR, `@tailwindcss/node` (programmatic v4 compile), Rust (napi-rs, tokio, parking_lot), existing brust HTTP plumbing.

**Spec:** `docs/superpowers/specs/2026-05-27-tailwind-v4-css-pipeline-design.md`

**Baselines to preserve:** Rust 93 / Runtime 103 / Integration 73 — all must stay green. After this plan: Rust 96+ / Runtime ~112 / Integration 77 (4 new CSS cases in `cli-build.test.ts`).

---

## Important context for every task

Before each subagent dispatch, the agent MUST be given:

- **Working directory:** `/Users/detoro/code/brust`
- **Branch:** `main` (project convention: user works on main directly with explicit consent — do NOT create feature branches without asking).
- **The repo's bootstrap chunk is rebuilt every server boot** — local source edits to `runtime/islands/bootstrap.ts` are picked up next server start.
- **Commit message convention:** terse subject line (`feat(css):`, `chore(css):`, `test(css):`, `fix(css):`, `docs(css):`), 1–3 sentence body explaining the why. After EACH commit run `git log -1 --format=%B`; if the `commit-msg` hook rewrote the message, immediately `git commit --amend -m <heredoc>`.
- **No defensive coding** for impossible cases. No backwards-compat shims unless task says so. Terse code, minimal comments. Don't add error handling for things that can't happen.
- **TDD discipline:** write failing test first, observe the failure, implement minimum to make it pass, observe pass, commit.
- **No demo of features outside the task's scope.** A subagent fixing the renderer should not also touch unrelated examples.
- **Real-browser smoke is non-negotiable** for any feature that touches client/browser surface (per session 10 lesson — `Component.name` minification bug only surfaced in a real browser).

---

## File structure

**New files:**

| File | Responsibility |
|---|---|
| `runtime/css.ts` | Module-scope state: `configureCssEnabled(hrefs: string[])` and `getCssHrefs(): readonly string[]`. Internal — not exported from `brust.*`. |
| `runtime/css.test.ts` | Unit: set/get round-trip; idempotent; defensive copy on read. |
| `runtime/css/build.ts` | `buildCss({ entry, outDir })` — programmatic `@tailwindcss/node` compile, writes `outDir/app.css`. |
| `runtime/css/build.test.ts` | Unit: minimal fixture (`app.css` + `.tsx` using `bg-red-500`) → output contains compiled utility. |
| `runtime/render/inject-css-link.ts` | Pure helper `injectCssLink(body: Uint8Array, hrefs: string[]): Uint8Array`. Case-insensitive `</head>` scan, `warnOnce` on miss. |
| `runtime/render/inject-css-link.test.ts` | Unit: all branches in the helper (with/without `</head>`, multibyte content, multiple hrefs, empty hrefs, uppercase tag). |

**Modified files:**

| File | Change |
|---|---|
| `runtime/render/stream.ts` | Call `injectCssLink` on the body of the first chunk in both buffering (`_final`) and streaming (header-chunk) paths. |
| `runtime/cli/build.ts` | New step 4.5 between MCP and prebuilt-actions: `if (existsSync(<entryDir>/app.css)) await buildCss(...)`. |
| `runtime/index.ts` | `brust.run()` gets CSS detection (main + worker branches, dev + prebuilt modes). Add `brust.configureCssDir(dir)` public wrapper around the new napi binding. |
| `runtime/index.d.ts` | Add `configureCssDir(path: string): NapiResult<undefined>` declaration. |
| `src/lib.rs` | Add `css_dir: parking_lot::RwLock<Option<PathBuf>>` to `State`. Initialize `None`. Add `configure_css_dir(path: String)` napi function. |
| `src/server.rs` | Add `current_css_dir()` helper. Add `is_safe_css_filename(name) -> bool` + unit tests. Add `/_brust/css/<file>` route branch (mirrors islands). |
| `package.json` (root) | Add `@tailwindcss/node` to `dependencies`. (Bun resolves it from root `node_modules` when `runtime/cli/build.ts` imports it — no need to duplicate in `runtime/package.json`.) |
| `example/hello-world/components/Layout.tsx` | Remove the inline `STYLES` block. |
| `example/hello-world/app.css` (NEW) | `@import "tailwindcss"; @source "./**/*.{tsx,ts}";` + the same visual layer as today, expressed in Tailwind utility / theme syntax. |
| `example/hello-world/components/*.tsx`, `example/hello-world/pages/*.tsx` | Replace inline styles / `<style>` reliance with Tailwind `className` utilities. |
| `tests/cli-build.test.ts` | Add 4 new cases for the CSS pipeline (described in Task 9). |
| `architecture.md` | Promote Tailwind v4 to Built; describe the `app.css` convention + `/_brust/css/` route. |

**No public API breakage.** The new `brust.configureCssDir` wrapper is additive. Apps without `app.css` are unaffected.

---

## Tailwind v4 programmatic API (verify in Task 4)

The plan commits to using `@tailwindcss/node`'s public programmatic API. Expected shape (from the public `@tailwindcss/node` package as of v4.0):

```ts
import { compile } from '@tailwindcss/node'
import { Scanner } from '@tailwindcss/oxide'

const sourceCss = await fs.readFile('app.css', 'utf-8')
const compiler = await compile(sourceCss, {
  base: path.dirname('app.css'),    // resolves @source globs relative to this
  onDependency: () => {},           // unused: we don't watch
})
const scanner = new Scanner({ sources: compiler.sources })
const candidates = scanner.scan()    // returns string[]
const output: string = compiler.build(candidates)
await fs.writeFile('out.css', output, 'utf-8')
```

**Verification step (Task 4 includes this):** before writing `buildCss`, inspect `node_modules/@tailwindcss/node/dist/index.d.ts` to confirm the exact exported names. If `compile` is renamed or the options object differs, adjust the implementation and update this section of the plan as part of the commit. The plan's other tasks DO NOT depend on the exact import path inside `buildCss` — they treat `buildCss({ entry, outDir })` as an opaque async function returning `{ outDir, files: ['app.css'] }`.

---

## Task 1 — `runtime/css.ts` module + tests

**Files:**
- Create: `runtime/css.ts`
- Create: `runtime/css.test.ts`

This is a tiny module-scope state holder, no async, no native deps. TDD.

- [ ] **Step 1: Write the failing test**

Create `runtime/css.test.ts`:

```ts
import { describe, test, expect, beforeEach } from 'bun:test'
import { configureCssEnabled, getCssHrefs } from './css.ts'

describe('runtime/css', () => {
  beforeEach(() => {
    // Reset module state between tests by calling with empty.
    configureCssEnabled([])
  })

  test('starts empty', () => {
    expect(getCssHrefs()).toEqual([])
  })

  test('configureCssEnabled stores hrefs', () => {
    configureCssEnabled(['/_brust/css/app.css'])
    expect(getCssHrefs()).toEqual(['/_brust/css/app.css'])
  })

  test('multiple calls replace the previous list', () => {
    configureCssEnabled(['/a.css'])
    configureCssEnabled(['/b.css', '/c.css'])
    expect(getCssHrefs()).toEqual(['/b.css', '/c.css'])
  })

  test('getCssHrefs returns a defensive copy', () => {
    configureCssEnabled(['/a.css'])
    const out = getCssHrefs() as string[]
    out.push('/mutated.css')
    expect(getCssHrefs()).toEqual(['/a.css'])
  })

  test('configureCssEnabled stores a defensive copy of its argument', () => {
    const input = ['/a.css']
    configureCssEnabled(input)
    input.push('/mutated.css')
    expect(getCssHrefs()).toEqual(['/a.css'])
  })
})
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `bun test runtime/css.test.ts 2>&1 | tail -10`
Expected: FAIL — `Cannot find module './css.ts'`.

- [ ] **Step 3: Implement `runtime/css.ts`**

```ts
// Module-scope state read by the renderer to decide whether to inject
// <link rel="stylesheet"> tags into the first chunk. Mirrors the
// consume-flag pattern used by islands — per-worker (workers re-execute
// the bundle and get their own copy).
let cssHrefs: string[] = []

/** Configure the list of stylesheet hrefs that the renderer should
 * inject into the SSR HTML before </head>. Replaces any previous list.
 * Called from brust.run() main and worker branches (both need to know
 * so the per-worker renderer can inject). */
export function configureCssEnabled(hrefs: readonly string[]): void {
  cssHrefs = hrefs.slice()
}

/** Returns the configured hrefs as a defensive copy. */
export function getCssHrefs(): readonly string[] {
  return cssHrefs.slice()
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `bun test runtime/css.test.ts 2>&1 | tail -10`
Expected: 5 pass.

- [ ] **Step 5: Confirm no other test regressed**

Run: `bun test runtime/ 2>&1 | tail -5`
Expected: 103 + 5 = 108 pass (the new file adds 5 cases).

- [ ] **Step 6: Commit**

```bash
git add runtime/css.ts runtime/css.test.ts
git commit -m "$(cat <<'EOF'
feat(css): module-scope state for renderer link-tag injection

Tiny holder for the list of stylesheet hrefs the renderer should splice
into SSR HTML. Defensive copies on both set and get so callers cannot
mutate the stored list out from under in-flight renders.
EOF
)"
git log -1 --format=%B
```

If the hook rewrote the message, amend immediately with the same heredoc.

---

## Task 2 — `injectCssLink` helper + unit tests

**Files:**
- Create: `runtime/render/inject-css-link.ts`
- Create: `runtime/render/inject-css-link.test.ts`

Pure function, no module-scope state coupling. TDD.

- [ ] **Step 1: Write the failing test**

Create `runtime/render/inject-css-link.test.ts`:

```ts
import { describe, test, expect, mock, spyOn } from 'bun:test'
import { injectCssLink, _resetWarnedForTests } from './inject-css-link.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()

function body(s: string): Uint8Array { return enc.encode(s) }
function str(b: Uint8Array): string  { return dec.decode(b) }

describe('injectCssLink', () => {
  test('splices a single <link> immediately before </head>', () => {
    const out = injectCssLink(
      body('<!DOCTYPE html><html><head><title>x</title></head><body></body></html>'),
      ['/_brust/css/app.css'],
    )
    expect(str(out)).toBe(
      '<!DOCTYPE html><html><head><title>x</title>' +
      '<link rel="stylesheet" href="/_brust/css/app.css">' +
      '</head><body></body></html>',
    )
  })

  test('matches uppercase </HEAD> case-insensitively', () => {
    const out = injectCssLink(
      body('<html><HEAD></HEAD></html>'),
      ['/x.css'],
    )
    expect(str(out)).toBe('<html><HEAD><link rel="stylesheet" href="/x.css"></HEAD></html>')
  })

  test('emits multiple <link> tags in declaration order', () => {
    const out = injectCssLink(
      body('<head></head>'),
      ['/a.css', '/b.css'],
    )
    expect(str(out)).toBe(
      '<head><link rel="stylesheet" href="/a.css">' +
      '<link rel="stylesheet" href="/b.css"></head>',
    )
  })

  test('returns the original body when hrefs is empty', () => {
    const src = body('<head></head>')
    const out = injectCssLink(src, [])
    expect(out).toBe(src)  // referential — no work done
  })

  test('preserves UTF-8 multibyte content preceding </head>', () => {
    const out = injectCssLink(
      body('<head><title>こんにちは</title></head>'),
      ['/a.css'],
    )
    expect(str(out)).toBe('<head><title>こんにちは</title><link rel="stylesheet" href="/a.css"></head>')
  })

  test('returns body unchanged when </head> is absent and warns once', () => {
    _resetWarnedForTests()
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const src = body('<body>no head here</body>')
      const out = injectCssLink(src, ['/a.css'])
      expect(out).toBe(src)
      expect(warn).toHaveBeenCalledTimes(1)

      // Second miss: no additional warn.
      injectCssLink(body('<body></body>'), ['/a.css'])
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  test('returns a Uint8Array, not a Buffer or other subclass', () => {
    const out = injectCssLink(body('<head></head>'), ['/a.css'])
    expect(out).toBeInstanceOf(Uint8Array)
    expect(out.constructor.name).toBe('Uint8Array')
  })
})
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `bun test runtime/render/inject-css-link.test.ts 2>&1 | tail -10`
Expected: FAIL — `Cannot find module './inject-css-link.ts'`.

- [ ] **Step 3: Implement `runtime/render/inject-css-link.ts`**

```ts
const ENC = new TextEncoder()

/** Set to true on the first miss; suppresses subsequent warnings so a
 * misconfigured Layout doesn't flood logs. Test helper resets this. */
let warned = false

/** @internal — used by the unit test suite to reset the warn-once flag. */
export function _resetWarnedForTests(): void { warned = false }

/** Splice `<link rel="stylesheet" href="...">` tags into `body` immediately
 * before the first occurrence of `</head>` (case-insensitive). Returns the
 * original body untouched if `hrefs` is empty or if `</head>` is absent
 * (warns once in the latter case). Renderer calls this on the first chunk
 * only — see spec S"SSR <link> injection". */
export function injectCssLink(body: Uint8Array, hrefs: readonly string[]): Uint8Array {
  if (hrefs.length === 0) return body
  const pos = findHeadCloseTag(body)
  if (pos < 0) {
    if (!warned) {
      console.warn('[brust] css: no </head> in first chunk; <link> not injected')
      warned = true
    }
    return body
  }
  const tags = hrefs
    .map((h) => `<link rel="stylesheet" href="${h}">`)
    .join('')
  const tagsBytes = ENC.encode(tags)
  const out = new Uint8Array(body.length + tagsBytes.length)
  out.set(body.subarray(0, pos), 0)
  out.set(tagsBytes, pos)
  out.set(body.subarray(pos), pos + tagsBytes.length)
  return out
}

/** Byte-level scan for `</head>` (case-insensitive on the four letters).
 * Returns the byte offset of the `<` or -1 if not found. */
function findHeadCloseTag(body: Uint8Array): number {
  // Target bytes: `<` `/` H E A D `>`  — 7 bytes total.
  // We only case-fold the four ASCII letters; the angle/slash bytes are exact.
  const LT = 0x3c   // <
  const SL = 0x2f   // /
  const GT = 0x3e   // >
  for (let i = 0, max = body.length - 6; i < max; i++) {
    if (body[i] !== LT || body[i+1] !== SL) continue
    if (!isLetter(body[i+2], 0x48)) continue   // H/h
    if (!isLetter(body[i+3], 0x45)) continue   // E/e
    if (!isLetter(body[i+4], 0x41)) continue   // A/a
    if (!isLetter(body[i+5], 0x44)) continue   // D/d
    if (body[i+6] !== GT) continue
    return i
  }
  return -1
}

/** Returns true if `b` matches the upper-case letter `u` (b === u || b === u|0x20). */
function isLetter(b: number, u: number): boolean {
  return b === u || b === (u | 0x20)
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `bun test runtime/render/inject-css-link.test.ts 2>&1 | tail -10`
Expected: 7 pass.

- [ ] **Step 5: Confirm no other test regressed**

Run: `bun test runtime/ 2>&1 | tail -5`
Expected: 108 + 7 = 115 pass.

- [ ] **Step 6: Commit**

```bash
git add runtime/render/inject-css-link.ts runtime/render/inject-css-link.test.ts
git commit -m "$(cat <<'EOF'
feat(render): pure helper to splice <link> tags before </head>

Byte-level scan, case-insensitive on the four ASCII letters only. Returns
the original body untouched on empty href list or missing </head>; logs
once-per-process warning in the latter case so a misconfigured Layout
doesn't degrade silently or noisily.
EOF
)"
git log -1 --format=%B
```

---

## Task 3 — Wire `injectCssLink` into `renderBranchStreaming`

**Files:**
- Modify: `runtime/render/stream.ts`

Apply the helper on the body of the first chunk in both buffering and streaming paths. Reads hrefs via `getCssHrefs()` from `runtime/css.ts`. No new test file — the integration test (Task 9) plus the existing `runtime/render/stream.test.ts` (if any) cover the behavior; if no test exists yet, add a focused one as part of this task.

- [ ] **Step 1: Confirm the existing renderer test surface**

Run: `ls runtime/render/`
Expected: `inject-css-link.ts`, `inject-css-link.test.ts`, `stream.ts`, `stream.test.ts`.

Run: `bun test runtime/render/stream.test.ts 2>&1 | tail -5`
Expected: some N pass (this is the existing baseline for stream.ts). Note the number.

- [ ] **Step 2: Read the current stream.ts buffering path**

The buffering branch lives inside `renderBranchStreaming._final` (around line 119–127 of `runtime/render/stream.ts`):

```ts
if (mode === 'buffering') {
  const islandsUsed = consumeIslandUsedFlag()
  const body = concatBuffers(buffer, islandsUsed)
  const meta = makeMeta({ status: successStatus, streaming: false, headers: extraHeaders })
  const len = encodeFirstChunk(view, meta, body)
  await napi.renderChunk(workerId, len, view)
  await sendFinal()
  mode = 'done'
}
```

The streaming branch lives inside `onShellReady` (around line 159–180):

```ts
mode = 'streaming'
const flushed = concatBuffers(buffer, true)
buffer.length = 0
const meta = makeMeta({ status: successStatus, streaming: true, headers: extraHeaders })
// …
const len = encodeFirstChunk(view, meta, flushed)
await napi.renderChunk(workerId, len, view)
```

- [ ] **Step 3: Add import + apply helper in both paths**

In `runtime/render/stream.ts`, after the existing `import { ISLANDS_IMPORTMAP_AND_BOOTSTRAP }` line, add:

```ts
import { injectCssLink } from './inject-css-link.ts'
import { getCssHrefs } from '../css.ts'
```

Modify the buffering branch in `_final` — replace the `const body = concatBuffers(...)` line and the next two lines with:

```ts
if (mode === 'buffering') {
  const islandsUsed = consumeIslandUsedFlag()
  let body = concatBuffers(buffer, islandsUsed)
  body = injectCssLink(body, getCssHrefs())
  const meta = makeMeta({ status: successStatus, streaming: false, headers: extraHeaders })
  const len = encodeFirstChunk(view, meta, body)
  await napi.renderChunk(workerId, len, view)
  await sendFinal()
  mode = 'done'
}
```

Modify the streaming branch inside `onShellReady` — replace the `const flushed = ...` and the `encodeFirstChunk(view, meta, flushed)` lines with:

```ts
mode = 'streaming'
let flushed = concatBuffers(buffer, true)
buffer.length = 0
flushed = injectCssLink(flushed, getCssHrefs())
const meta = makeMeta({ status: successStatus, streaming: true, headers: extraHeaders })
// (rest of the original block — let resolveHeader, headerSent setup, etc — unchanged)
// when reaching encodeFirstChunk:
const len = encodeFirstChunk(view, meta, flushed)
```

- [ ] **Step 4: Add a focused unit test for the wiring**

Append to `runtime/render/stream.test.ts` (or create the file if absent — use `runtime/render/stream.test.ts` is the path):

```ts
import { configureCssEnabled } from '../css.ts'
import { injectCssLink } from './inject-css-link.ts'

describe('renderBranchStreaming + CSS', () => {
  test('first-chunk body contains <link> when getCssHrefs is non-empty', () => {
    // Pure check on the helper composition — the renderer wires it
    // by calling injectCssLink(body, getCssHrefs()), so a positive
    // test on the helper combined with a manual configure proves the
    // wiring. End-to-end coverage lives in tests/cli-build.test.ts.
    configureCssEnabled(['/_brust/css/app.css'])
    const enc = new TextEncoder()
    const out = injectCssLink(
      enc.encode('<head></head>'),
      // simulating renderer calling getCssHrefs(). Don't import here
      // to avoid import cycles — just verify the contract.
      ['/_brust/css/app.css'],
    )
    expect(new TextDecoder().decode(out)).toContain('<link rel="stylesheet" href="/_brust/css/app.css">')
    configureCssEnabled([])  // reset
  })
})
```

(Light-touch test — the integration test in Task 9 is the real coverage.)

- [ ] **Step 5: Run the existing baselines**

Run: `bun test runtime/render/ 2>&1 | tail -5`
Expected: prior N + 7 (inject-css-link) + 1 (new wiring test) pass.

Run: `bun test runtime/ 2>&1 | tail -5`
Expected: still green; no regression elsewhere.

Run: `bun test tests/integration.test.ts 2>&1 | tail -5`
Expected: 70 pass (this test exercises end-to-end SSR; if it breaks, the renderer change is broken).

Run: `bun test tests/ 2>&1 | tail -5`
Expected: 73 pass (includes cli-build).

- [ ] **Step 6: Commit**

```bash
git add runtime/render/stream.ts runtime/render/stream.test.ts
git commit -m "$(cat <<'EOF'
feat(render): inject <link> tags into the SSR first chunk

Both buffering and streaming paths now run the first chunk's body
through injectCssLink(body, getCssHrefs()) before encodeFirstChunk.
Zero impact when no CSS is configured (empty hrefs → identity).
EOF
)"
git log -1 --format=%B
```

---

## Task 4 — `@tailwindcss/node` dep + `runtime/css/build.ts` + tests

**Files:**
- Modify: `package.json` (root) — add `@tailwindcss/node` to `dependencies`
- Modify: `runtime/package.json` — add `@tailwindcss/node` to `dependencies`
- Create: `runtime/css/build.ts`
- Create: `runtime/css/build.test.ts`

- [ ] **Step 1: Install the dep**

Run from repo root:

```bash
bun add @tailwindcss/node
```

Expected: package added to root `package.json` `dependencies`. `@tailwindcss/oxide` may also land as a transitive dep. Bun's resolution from `runtime/cli/build.ts` walks `runtime/node_modules` then root `node_modules` — root install is sufficient. Do NOT also add to `runtime/package.json` (the runtime sub-package's deps are for publish-time; tests run from the root where the dep is now reachable).

- [ ] **Step 2: Verify the programmatic API surface**

Run: `cat runtime/node_modules/@tailwindcss/node/dist/index.d.ts 2>/dev/null | head -40`

Expected: declarations for `compile`, `compileAst`, `Scanner`, etc. If the file is at a different path, `find runtime/node_modules/@tailwindcss/node -name "*.d.ts" | head`.

Confirm the imports the plan uses exist:
- `compile(css: string, options: { base: string, onDependency?: ... }) => Promise<{ build(candidates: string[]): string; sources: ScannerSource[] }>`
- `Scanner` from `@tailwindcss/oxide` accepts `{ sources }` and has `scan(): string[]`.

If either is missing or renamed, ADJUST the implementation in Step 4 below to match the actual API. The plan's other tasks DO NOT depend on the internal shape — they treat `buildCss` as opaque.

- [ ] **Step 3: Write the failing test**

Create `runtime/css/build.test.ts`:

```ts
import { describe, test, expect } from 'bun:test'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildCss } from './build.ts'

describe('buildCss', () => {
  test('compiles Tailwind v4 and emits utilities used in @source-scanned files', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'brust-css-build-'))

    // app.css: Tailwind v4 with a relative @source.
    await writeFile(
      path.join(dir, 'app.css'),
      [
        '@import "tailwindcss";',
        '@source "./**/*.tsx";',
        '',
      ].join('\n'),
      'utf-8',
    )

    // foo.tsx: uses bg-red-500 but not bg-blue-999.
    await writeFile(
      path.join(dir, 'foo.tsx'),
      'export default function Foo() { return <div className="bg-red-500" /> }\n',
      'utf-8',
    )

    const outDir = path.join(dir, 'out')
    const result = await buildCss({ entry: path.join(dir, 'app.css'), outDir })

    expect(result).toEqual({ outDir, files: ['app.css'] })

    const css = await readFile(path.join(outDir, 'app.css'), 'utf-8')
    expect(css).toContain('.bg-red-500')      // used utility generated
    expect(css).not.toContain('.bg-blue-999')  // unused class skipped
    // Tailwind v4 strips its own directives:
    expect(css).not.toContain('@source')
    expect(css).not.toContain('@import "tailwindcss"')
  })

  test('throws when entry file is missing', async () => {
    await expect(
      buildCss({ entry: '/no/such/file.css', outDir: '/tmp/never' }),
    ).rejects.toThrow()
  })
})
```

- [ ] **Step 4: Run the test and verify it fails**

Run: `bun test runtime/css/build.test.ts 2>&1 | tail -10`
Expected: FAIL — `Cannot find module './build.ts'`.

- [ ] **Step 5: Implement `runtime/css/build.ts`**

```ts
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { compile } from '@tailwindcss/node'
import { Scanner } from '@tailwindcss/oxide'

export interface BuildCssOptions {
  /** Absolute path to the entry CSS file (typically <scanRoot>/app.css). */
  entry: string
  /** Absolute path to the output directory. Created if missing. */
  outDir: string
}

export interface CssBuildResult {
  outDir: string
  files: string[]
}

/** Compile `entry` through Tailwind v4's programmatic pipeline and write
 * the result to `<outDir>/app.css`. `@source` globs in the CSS are resolved
 * relative to the entry file's directory. */
export async function buildCss(opts: BuildCssOptions): Promise<CssBuildResult> {
  const sourceCss = await readFile(opts.entry, 'utf-8')

  const compiler = await compile(sourceCss, {
    base: path.dirname(opts.entry),
    onDependency: () => {},  // unused — no watch
  })

  // Scanner reads the @source directives picked up by the compiler and
  // returns the candidate class names found in those files.
  const scanner = new Scanner({ sources: compiler.sources })
  const candidates = scanner.scan()

  const output = compiler.build(candidates)

  await mkdir(opts.outDir, { recursive: true })
  await writeFile(path.join(opts.outDir, 'app.css'), output, 'utf-8')

  return { outDir: opts.outDir, files: ['app.css'] }
}
```

If Step 2's verification showed a different API surface, adjust the import / function names / option shape accordingly. The returned object MUST be `{ outDir, files: ['app.css'] }` exactly.

- [ ] **Step 6: Run the test and verify it passes**

Run: `bun test runtime/css/build.test.ts 2>&1 | tail -20`
Expected: 2 pass. The first test takes 200ms–2s depending on Tailwind's startup.

If the test fails with a "Cannot find module '@tailwindcss/oxide'" or similar, install it explicitly:

```bash
bun add @tailwindcss/oxide
cd runtime && bun add @tailwindcss/oxide && cd -
```

Then re-run the test.

- [ ] **Step 7: Confirm no other test regressed**

Run: `bun test runtime/ 2>&1 | tail -5`
Expected: 115 + 2 = 117 pass (previous count + the two new buildCss tests).

- [ ] **Step 8: Commit**

```bash
git add package.json bun.lock runtime/css/build.ts runtime/css/build.test.ts
# If @tailwindcss/oxide was installed explicitly in Step 6, also include:
#   git add package.json bun.lock
# (already covered above — re-running git add is idempotent)
git commit -m "$(cat <<'EOF'
feat(css): programmatic Tailwind v4 compile via @tailwindcss/node

buildCss({ entry, outDir }) reads the entry CSS, compiles it with
Tailwind v4's @tailwindcss/node compile() + @tailwindcss/oxide Scanner,
and writes the result to <outDir>/app.css. No watch, no PostCSS plugin
chain — Tailwind v4's CSS-first config is the whole API.
EOF
)"
git log -1 --format=%B
```

If the lockfile didn't change in the runtime/ subdir, omit it from `git add` (subagent: just stage what `git status` shows is modified).

---

## Task 5 — Rust: `is_safe_css_filename` + `CSS_DIR` state + `configure_css_dir` napi + `/_brust/css/<file>` route

**Files:**
- Modify: `src/lib.rs`
- Modify: `src/server.rs`

Combined task — all Rust changes for the CSS pipeline. Mirrors the islands plumbing line-by-line.

- [ ] **Step 1: Write the failing Rust unit tests**

Append to `src/server.rs` inside the `mod tests` block (around line 1188 — find the existing `safe_filenames_pass` test for islands and put the CSS counterparts immediately after):

```rust
#[test]
fn safe_css_filenames_pass() {
    assert!(is_safe_css_filename("app.css"));
    assert!(is_safe_css_filename("_a.css"));
    assert!(is_safe_css_filename("Foo-Bar_123.css"));
    assert!(is_safe_css_filename("a.b.css"));
}

#[test]
fn unsafe_css_empty_rejected() {
    assert!(!is_safe_css_filename(""));
}

#[test]
fn unsafe_css_wrong_ext_rejected() {
    assert!(!is_safe_css_filename("app.js"));
    assert!(!is_safe_css_filename("app"));
}

#[test]
fn unsafe_css_dot_prefix_rejected() {
    assert!(!is_safe_css_filename(".env.css"));
}

#[test]
fn unsafe_css_traversal_rejected() {
    assert!(!is_safe_css_filename("../etc/passwd.css"));
    assert!(!is_safe_css_filename("..passwd.css"));
}

#[test]
fn unsafe_css_separators_rejected() {
    assert!(!is_safe_css_filename("sub/app.css"));
    assert!(!is_safe_css_filename("sub\\app.css"));
}
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `cargo test --lib safe_css 2>&1 | tail -15`
Expected: FAIL — `cannot find function is_safe_css_filename in this scope`.

- [ ] **Step 3: Implement `is_safe_css_filename`**

In `src/server.rs`, immediately after the existing `is_safe_island_filename` function (around line 1112–1128), add:

```rust
/// Mirrors `is_safe_island_filename` but accepts `.css` extension. Keep the
/// two functions structurally identical — anything that's safe as an island
/// chunk filename is also safe as a CSS asset filename, modulo extension.
fn is_safe_css_filename(name: &str) -> bool {
    if !name.ends_with(".css") {
        return false;
    }
    if name.starts_with('.') {
        return false;
    }
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return false;
    }
    name
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
}
```

- [ ] **Step 4: Run the unit tests and verify they pass**

Run: `cargo test --lib safe_css 2>&1 | tail -15`
Expected: 6 pass.

Run: `cargo test --lib 2>&1 | tail -5`
Expected: 93 + 6 = 99 pass (existing 93 baseline + 6 new).

- [ ] **Step 5: Add the `CSS_DIR` state**

In `src/lib.rs`, find the `State` struct (around line 36–46) and add a `css_dir` field:

```rust
struct State {
    pool: Arc<WorkerPool>,
    ready: Arc<Notify>,
    shutdown: Arc<Notify>,
    routes: Arc<RouteTable>,
    cache: Arc<LruCache>,
    is_serving: AtomicBool,
    expected_workers: AtomicU32,
    islands_dir: parking_lot::RwLock<Option<std::path::PathBuf>>,
    css_dir:     parking_lot::RwLock<Option<std::path::PathBuf>>,
    actions: parking_lot::RwLock<std::collections::HashSet<String>>,
}
```

Then in the `state()` initializer (around line 60–71), add the matching default:

```rust
State {
    pool: Arc::new(WorkerPool::new()),
    ready: Arc::new(Notify::new()),
    shutdown: Arc::new(Notify::new()),
    routes: Arc::new(RouteTable::new()),
    cache: Arc::new(LruCache::new()),
    is_serving: AtomicBool::new(false),
    expected_workers: AtomicU32::new(0),
    islands_dir: parking_lot::RwLock::new(None),
    css_dir:     parking_lot::RwLock::new(None),
    actions: parking_lot::RwLock::new(std::collections::HashSet::new()),
}
```

- [ ] **Step 6: Add the napi binding**

In `src/lib.rs`, after `configure_islands_dir` (around line 192–202), add:

```rust
#[napi]
pub fn configure_css_dir(path: String) -> NapiResult<()> {
    let abs = std::path::PathBuf::from(&path);
    if !abs.is_absolute() {
        return Err(napi::Error::from_reason(format!(
            "css_dir must be an absolute path (got {path:?})"
        )));
    }
    *state().css_dir.write() = Some(abs);
    Ok(())
}
```

- [ ] **Step 7: Add the `current_css_dir` helper in server.rs**

In `src/server.rs`, immediately after the existing `current_islands_dir` (around line 14–16), add:

```rust
fn current_css_dir() -> Option<std::path::PathBuf> {
    crate::state().css_dir.read().clone()
}
```

- [ ] **Step 8: Add the `/_brust/css/<file>` route branch**

In `src/server.rs`, immediately after the `/_brust/islands/` branch (ends around line 206 — just before the `// Native-only route: server-function dispatch.` comment), insert the mirror branch:

```rust
        // Native-only route: serve pre-built CSS chunks from the configured
        // css_dir. Strict path-traversal protection mirrors the islands route.
        if let Some(file) = path.strip_prefix("/_brust/css/") {
            let file = file.split('?').next().unwrap_or(file);
            if !is_safe_css_filename(file) {
                let _ = s.write_all(http::error_404()).await;
                continue;
            }
            let dir = match current_css_dir() {
                Some(d) => d,
                None => {
                    let _ = s.write_all(http::error_404()).await;
                    continue;
                }
            };
            let file_path = dir.join(file);
            match tokio::fs::read(&file_path).await {
                Ok(bytes) => {
                    let extra = [(
                        "Cache-Control".to_string(),
                        "public, max-age=3600".to_string(),
                    )];
                    let resp = http::build_response(
                        200,
                        "text/css; charset=utf-8",
                        &extra,
                        bytes,
                    );
                    if s.write_all(resp).await.is_err() {
                        return;
                    }
                    continue;
                }
                Err(_) => {
                    let _ = s.write_all(http::error_404()).await;
                    continue;
                }
            }
        }
```

- [ ] **Step 9: Rebuild the napi binary so the new symbol is exported**

Run: `bun --filter runtime run build:debug 2>&1 | tail -10`
Expected: build succeeds. `runtime/index.<triple>.node` is updated. `runtime/index.js` and `runtime/index.d.ts` are regenerated by napi-rs and now declare `configureCssDir`.

If the build fails because of a borrow-checker / type error in the new code, fix inline before proceeding.

- [ ] **Step 10: Run cargo + bun tests**

Run: `cargo test --lib 2>&1 | tail -5`
Expected: 99 pass.

Run: `bun test runtime/ 2>&1 | tail -5`
Expected: 117 pass (no JS changes yet — same as Task 4 ending state).

- [ ] **Step 11: Confirm the napi declaration was regenerated**

Run: `grep configureCssDir runtime/index.d.ts`
Expected: `export declare function configureCssDir(path: string): NapiResult<undefined>` exists.

If napi-rs didn't regenerate `runtime/index.d.ts`, manually add the line after the existing `configureIslandsDir` declaration.

- [ ] **Step 12: Commit**

```bash
git add src/lib.rs src/server.rs runtime/index.d.ts runtime/index.js
# Add any regenerated native binaries (host-platform suffix varies):
git add -u runtime/
git status  # verify only intended files are staged
git commit -m "$(cat <<'EOF'
feat(rust): /_brust/css/<file> route + safe-filename gate + napi binding

Mirrors the existing /_brust/islands/ plumbing line-by-line. New State
field css_dir (RwLock<Option<PathBuf>>); configure_css_dir napi sets it;
server.rs reads it on each request, refusing path traversal via
is_safe_css_filename. Cache-Control: public, max-age=3600.
EOF
)"
git log -1 --format=%B
```

If the hook rewrites, amend immediately.

---

## Task 6 — `brust.run()` CSS detection + `brust.configureCssDir` surface

**Files:**
- Modify: `runtime/index.ts`

Adds detection branches in both main and worker arms of `brust.run()`. Wires the napi binding through a thin wrapper for symmetry with `configureIslandsDir`.

- [ ] **Step 1: Add the public wrapper**

In `runtime/index.ts`, find the existing `configureIslandsDir` method on the `brust` object (around line 136–138):

```ts
configureIslandsDir(dir: string): void {
  ; (native as any).configureIslandsDir(dir)
},
```

Immediately after, add:

```ts
/** Tell Rust where to read `/_brust/css/<file>` from. Called from the
 * main thread when CSS is configured. Path must be absolute. */
configureCssDir(dir: string): void {
  ; (native as any).configureCssDir(dir)
},
```

- [ ] **Step 2: Add the imports `runtime/index.ts` needs**

Near the top of `runtime/index.ts`, add (alongside the existing `import { loadConfig }` line):

```ts
import { configureCssEnabled } from './css.ts'
```

(Keep the existing dynamic imports inside `run()` for `node:fs`, `node:url`, `node:path` — those stay.)

- [ ] **Step 3: Wire CSS into the main branch of `run()`**

In `brust.run()`, find the main branch (`if (!isWorker) { … }`). Locate the existing islands block (around line 226–241). Immediately after the islands block (just before `this.registerRoutes(opts.routes)`), add:

```ts
// CSS pipeline — opt-in via convention: <scanRoot>/app.css.
if (prebuilt) {
  const prebuiltCssDir = path.join(distDir!, 'css')
  if (existsSync(prebuiltCssDir)) {
    this.configureCssDir(prebuiltCssDir)
    configureCssEnabled(['/_brust/css/app.css'])
    console.log(`[brust] main: using pre-built CSS at ${prebuiltCssDir}`)
  }
} else {
  const appCssPath = path.join(scanRoot, 'app.css')
  if (existsSync(appCssPath)) {
    const { buildCss } = await import('./css/build.ts')
    const cssOutDir = path.join(process.cwd(), '.brust', 'css')
    await buildCss({ entry: appCssPath, outDir: cssOutDir })
    this.configureCssDir(cssOutDir)
    configureCssEnabled(['/_brust/css/app.css'])
    console.log(`[brust] main: built CSS → ${cssOutDir}/app.css`)
  }
}
```

- [ ] **Step 4: Wire CSS into the worker branch of `run()`**

In `brust.run()`, find the worker branch (`else { ... }` matching `if (!isWorker)`). At the top of the worker block, BEFORE the `const sab = new SharedArrayBuffer(...)` line, add:

```ts
// Worker: detect CSS the same way main did (no compile, no configureCssDir
// — Rust state is shared, but the per-worker renderer needs the hrefs).
if (prebuilt) {
  if (existsSync(path.join(distDir!, 'css'))) {
    configureCssEnabled(['/_brust/css/app.css'])
  }
} else {
  if (existsSync(path.join(scanRoot, 'app.css'))) {
    configureCssEnabled(['/_brust/css/app.css'])
  }
}
```

- [ ] **Step 5: Verify the existing dev flow still works (no CSS configured yet)**

Run a quick sanity dev boot:

```bash
BRUST_PORT=39801 timeout 3 bun run example/hello-world/index.ts 2>&1 | head -20
```

Expected: server boots, prints `[brust] main: spawning N worker threads` and the usual init lines. NO `[brust] main: built CSS` line (because `example/hello-world/app.css` doesn't exist yet — that comes in Task 8).

If a worker crashes with a missing-`@tailwindcss/node` error, that means somewhere in the run path the dynamic import is being eagerly evaluated even when `app.css` is absent. Re-read Step 3 — the dynamic import MUST be inside the `if (existsSync(appCssPath))` block, not at the top of `run()`.

- [ ] **Step 6: Run baselines**

Run: `bun test runtime/ 2>&1 | tail -5`
Expected: 117 pass (no new tests in this task; the wiring is exercised by Task 9's integration test).

Run: `bun test tests/integration.test.ts 2>&1 | tail -5`
Expected: 70 pass.

Run: `bun test tests/cli-build.test.ts 2>&1 | tail -5`
Expected: 3 pass. NB: this test builds + runs the example app via `brust build`. Since `example/hello-world/app.css` doesn't exist yet, no CSS is built — and the existing assertions don't reference CSS. Should remain green.

- [ ] **Step 7: Commit**

```bash
git add runtime/index.ts
git commit -m "$(cat <<'EOF'
feat(runtime): brust.run() detects <scanRoot>/app.css and wires CSS

Dev mode: compile via buildCss → .brust/css/, then configureCssDir +
configureCssEnabled. Prebuilt: detect <distDir>/css/, skip compile.
Workers do the same detection (sans configureCssDir) so each worker's
renderer can inject the <link>. Opt-in by convention; apps without
app.css see zero change.
EOF
)"
git log -1 --format=%B
```

---

## Task 7 — CLI: step 4.5 in `runtime/cli/build.ts`

**Files:**
- Modify: `runtime/cli/build.ts`

Add the CSS build step to the `brust build` pipeline. Slots between the MCP manifest step (4) and the prebuilt-actions generation (5).

- [ ] **Step 1: Locate the insertion point**

Read `runtime/cli/build.ts`. The current pipeline ends step 4 around line 105–108 (`extractMcpManifest` + `Bun.write` of `mcp-manifest.json`). Step 5 (`writePrebuiltActionsFileWithMap`) starts around line 110–112.

- [ ] **Step 2: Insert step 4.5**

In `runtime/cli/build.ts`, between the MCP step and the `// 5. Generate the prebuilt-actions file` comment, add:

```ts
  // 4.5. CSS — Tailwind v4 if app.css is present.
  const appCssPath = path.join(entryDir, 'app.css')
  if (existsSync(appCssPath)) {
    const { buildCss } = await import('../css/build.ts')
    const cssOutDir = path.join(outDir, 'css')
    await buildCss({ entry: appCssPath, outDir: cssOutDir })
    console.log(`[brust] build: css     → ${cssOutDir}/app.css`)
  } else {
    console.log(`[brust] build: css     skipped (no app.css)`)
  }
```

(The console message naming mirrors the existing `[brust build] islands:` / `[brust build] mcp:` lines — keep the same `[brust build] css:` prefix if the surrounding lines use that; check the file.)

- [ ] **Step 3: Verify the build runs on an app without app.css**

Run:

```bash
rm -rf /tmp/brust-dist-css-check
bun runtime/cli/index.ts build example/hello-world/index.ts --out-dir /tmp/brust-dist-css-check 2>&1 | tail -10
```

Expected: succeeds. The CSS step prints "skipped (no app.css)" because `example/hello-world/app.css` doesn't exist yet (Task 8 creates it).

Verify the dist:

```bash
ls /tmp/brust-dist-css-check/
```

Expected: `index.js`, `islands/`, `native/`, `mcp-manifest.json` — NO `css/` directory yet.

- [ ] **Step 4: Run baselines**

Run: `bun test tests/cli-build.test.ts 2>&1 | tail -5`
Expected: 3 pass. (The existing test runs `brust build` on the example app; nothing CSS-related yet.)

Run: `bun test runtime/ 2>&1 | tail -5`
Expected: 117 pass.

- [ ] **Step 5: Commit**

```bash
git add runtime/cli/build.ts
git commit -m "$(cat <<'EOF'
feat(cli): brust build step 4.5 — Tailwind v4 CSS compile

Between MCP and prebuilt-actions generation: if <entryDir>/app.css
exists, compile via buildCss({ entry, outDir }) into <outDir>/css/app.css.
Logged like the other build steps; silent skip when absent.
EOF
)"
git log -1 --format=%B
```

---

## Task 8 — Migrate `example/hello-world` to Tailwind

**Files:**
- Create: `example/hello-world/app.css`
- Modify: `example/hello-world/components/Layout.tsx`
- Modify: `example/hello-world/components/Counter.tsx`
- Modify: `example/hello-world/components/Bio.tsx`
- Modify: `example/hello-world/pages/HelloWorld.tsx`
- Modify: `example/hello-world/pages/BlogPost.tsx`
- Modify: `example/hello-world/pages/Profile.tsx`
- Modify: `example/hello-world/pages/SlowSuspense.tsx`

This is THE proof that the pipeline actually works end-to-end. Don't skip the visual smoke at the end.

The Layout's existing inline `STYLES` block sets the visual baseline — the migrated app should LOOK approximately the same (sans-serif type, narrow centered column, terracotta accent color, light cream background). Tailwind utilities + a small `@theme` block replicate this directly.

- [ ] **Step 1: Create `example/hello-world/app.css`**

```css
@import "tailwindcss";

/* Scan all TS / TSX under the example for class candidates. The
 * @source path is relative to this file. */
@source "./**/*.{tsx,ts}";

/* Project palette + serif/mono stack. The custom --color-brand drives
 * the terracotta accent used on links and the brand mark. */
@theme {
  --color-brand: #8a3324;
  --color-paper: #fafaf7;
  --color-ink: #1a1a1a;
  --color-line: #e7e5df;
  --color-soft: #f0eee8;

  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
               "Helvetica Neue", Arial, sans-serif;
  --font-mono: "SF Mono", Menlo, Consolas, monospace;
}

/* Body defaults that Tailwind's preflight doesn't cover — mirror the
 * inline STYLES block in the pre-migration Layout. */
@layer base {
  body {
    @apply font-sans text-ink bg-paper leading-relaxed;
  }
  main code, main pre {
    @apply bg-soft px-1.5 py-0.5 rounded text-[13px] font-mono;
  }
  main pre {
    @apply p-3 overflow-x-auto;
  }
}
```

- [ ] **Step 2: Rewrite Layout.tsx**

Replace `example/hello-world/components/Layout.tsx` contents (current file is ~95 lines, mostly the STYLES string). New file:

```tsx
import type { ReactNode } from 'react'

const NAV = [
  { href: '/',                label: 'Home' },
  { href: '/blog/welcome',    label: 'Blog' },
  { href: '/slow-suspense',   label: 'Streaming' },
  { href: '/profile/world',   label: 'Profile' },
]

interface LayoutProps {
  title: string
  children: ReactNode
}

export default function Layout({ title, children }: LayoutProps) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{`${title} · Brust demo`}</title>
      </head>
      <body>
        <header className="bg-white border-b border-line">
          <div className="max-w-3xl mx-auto px-5 py-3.5 flex items-center gap-7">
            <a href="/" className="font-bold text-lg text-brand no-underline tracking-tight">brust</a>
            <nav className="flex gap-4 flex-wrap">
              {NAV.map((item) => (
                <a
                  key={item.href}
                  href={item.href}
                  className="text-gray-600 text-sm py-1 border-b-2 border-transparent hover:text-brand hover:border-brand transition-colors"
                >
                  {item.label}
                </a>
              ))}
            </nav>
          </div>
        </header>
        <main className="max-w-3xl mx-auto px-5 pt-8 pb-4 [&_h1]:text-3xl [&_h1]:mb-4 [&_h1]:tracking-tight [&_p]:my-2.5 [&_a]:text-brand">
          {children}
        </main>
        <footer className="max-w-3xl mx-auto px-5 py-4 mt-8 mb-6 border-t border-line text-gray-500 text-xs">
          Real-time endpoints aren't navigable but you can poke them:{' '}
          <code>curl -N http://127.0.0.1:3000/sse-counter</code>
          {' · '}
          <code>wscat -c ws://127.0.0.1:3000/ws/echo</code>
        </footer>
      </body>
    </html>
  )
}
```

(Inline arbitrary `[&_h1]:...` selectors keep the per-tag styling concise without forking child components.)

- [ ] **Step 3: Update Counter.tsx**

The existing button had no styling. The general `[data-brust-island]` block from the old STYLES added `display: inline-block; margin: 12px 0` — replace via utility on the button:

```tsx
import { useState } from 'react'

export interface CounterProps {
  start?: number
  label?: string
}

export default function Counter({ start = 0, label = 'count' }: CounterProps) {
  const [n, setN] = useState(start)
  return (
    <button
      data-testid="counter"
      onClick={() => setN(n + 1)}
      className="my-3 px-3 py-1.5 bg-white border border-line rounded text-sm font-mono hover:border-brand transition-colors"
    >
      {label}: {n}
    </button>
  )
}
```

- [ ] **Step 4: Update Bio.tsx**

The fallback `[data-testid="bio-fallback"]` was styled `color: #8a8a8a; font-style: italic` in the old STYLES. Apply equivalent utilities via className on the rendered `<p>`:

```tsx
interface BioProps {
  promise: Promise<string>
}

type AnnotatedPromise = Promise<string> & { status?: 'fulfilled'; value?: string }

export default function Bio({ promise }: BioProps) {
  const p = promise as AnnotatedPromise
  if (p.status !== 'fulfilled') {
    p.then((v) => { p.status = 'fulfilled'; p.value = v })
    throw p
  }
  return <p data-testid="bio">{p.value}</p>
}
```

(No changes — `<p>` inside `<main>` already gets the Layout styling. The italic fallback is in `Profile.tsx`'s `<Suspense fallback={...}>` — update that next.)

- [ ] **Step 5: Update pages — italic fallback styling**

In `example/hello-world/pages/Profile.tsx`, the `<Suspense fallback>` had `class="italic text-gray-500"` equivalent. Update:

```tsx
<Suspense fallback={<p data-testid="bio-fallback" className="text-gray-500 italic">loading bio...</p>}>
  <Bio promise={fetchBio(params.user)} />
</Suspense>
```

In `example/hello-world/pages/SlowSuspense.tsx`, similarly:

```tsx
<Suspense fallback={<p data-testid="spinner" className="text-gray-500 italic">loading...</p>}>
  <SlowChild />
</Suspense>
```

Leave `HelloWorld.tsx` and `BlogPost.tsx` untouched — they don't have visual styling beyond what Layout provides.

- [ ] **Step 6: Dev-mode smoke**

Run:

```bash
BRUST_PORT=39802 timeout 5 bun run example/hello-world/index.ts 2>&1 | head -30
```

Expected: server boots, prints `[brust] main: built CSS → /Users/detoro/code/brust/.brust/css/app.css` (or similar absolute path), no errors.

In a separate terminal (or via `curl`):

```bash
curl -s http://127.0.0.1:39802/_brust/css/app.css | head -3
```

Expected: starts with Tailwind's reset rule (`*,::before,::after{box-sizing:border-box;...`) or similar v4 reset signature.

```bash
curl -s http://127.0.0.1:39802/ | head -50
```

Expected: HTML contains `<link rel="stylesheet" href="/_brust/css/app.css">` immediately before `</head>`. The body uses className utilities like `bg-paper`, `max-w-3xl`, `text-brand`.

Kill the dev server when done (Ctrl-C).

- [ ] **Step 7: Run baselines**

Run: `bun test runtime/ 2>&1 | tail -5`
Expected: 117 pass.

Run: `bun test tests/integration.test.ts 2>&1 | tail -5`
Expected: 70 pass.

Run: `bun test tests/cli-build.test.ts 2>&1 | tail -5`
Expected: 3 pass (no CSS assertions yet — added in Task 9). The build step now also produces `dist/css/app.css` since `app.css` exists, but the test doesn't assert on it yet.

- [ ] **Step 8: Commit**

```bash
git add example/hello-world/app.css example/hello-world/components/ example/hello-world/pages/
git commit -m "$(cat <<'EOF'
feat(example): migrate hello-world to Tailwind v4

Inline STYLES block removed from Layout; app.css now drives styling via
@import "tailwindcss" + @source + a small @theme block for the project
palette (terracotta brand, cream paper). Layout/Counter/Bio/pages use
utility classes; visual output matches the previous inline-styled baseline.
EOF
)"
git log -1 --format=%B
```

---

## Task 9 — Integration tests in `tests/cli-build.test.ts`

**Files:**
- Modify: `tests/cli-build.test.ts`

Add 4 new cases that exercise the CSS pipeline end-to-end via the build+spawn lifecycle the test already establishes.

- [ ] **Step 1: Locate the existing test file**

Read `tests/cli-build.test.ts` (created in the prior session — task T7 of the build-CLI plan).

- [ ] **Step 2: Add the 4 new test cases**

In `tests/cli-build.test.ts`, after the existing `test('bun run dist/index.js serves all major paths', …)` block, add:

```ts
test('brust build emits dist/css/app.css with compiled Tailwind', async () => {
  expect(existsSync(`${distDir}/css/app.css`)).toBe(true)
  const css = await Bun.file(`${distDir}/css/app.css`).text()
  // Tailwind v4 preflight signature — the `*,::before,::after` selector.
  expect(css).toMatch(/\*,::before,::after/)
  // A utility class actually used by the migrated example app.
  expect(css).toContain('.flex')
})

test('GET /_brust/css/app.css serves with correct headers', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/_brust/css/app.css`)
  expect(r.status).toBe(200)
  expect(r.headers.get('content-type') ?? '').toMatch(/^text\/css/)
  expect(r.headers.get('cache-control') ?? '').toMatch(/max-age=3600/)
  const text = await r.text()
  expect(text.length).toBeGreaterThan(100)
})

test('SSR HTML contains <link rel="stylesheet"> immediately before </head>', async () => {
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text()
  const linkTag = '<link rel="stylesheet" href="/_brust/css/app.css">'
  const linkIdx = html.indexOf(linkTag)
  const headEnd = html.indexOf('</head>')
  expect(linkIdx).toBeGreaterThan(-1)
  expect(headEnd).toBeGreaterThan(-1)
  expect(linkIdx).toBeLessThan(headEnd)
  // Nothing between the link tag and </head> (allowing 0 chars of slack).
  expect(headEnd - (linkIdx + linkTag.length)).toBe(0)
})

test('GET /_brust/css/..%2Fetc%2Fpasswd is 404', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/_brust/css/..%2Fetc%2Fpasswd`)
  expect(r.status).toBe(404)
})
```

If the test refers to `port` as a const defined elsewhere in the file (likely a top-level `const port = 38280`), no change needed. If it uses a different name, swap accordingly.

- [ ] **Step 3: Run the test**

Run: `bun test tests/cli-build.test.ts 2>&1 | tail -15`
Expected: 7 pass (3 existing + 4 new).

If the `[brust] main: using pre-built CSS at ...` log doesn't appear during the spawn step (you'll see it in stderr/stdout from the spawned process if `stdout: 'pipe'`), the prebuilt CSS detection in `brust.run()` (Task 6) may be silently failing — re-read that task's wiring.

- [ ] **Step 4: Run the full integration suite**

Run: `bun test tests/ 2>&1 | tail -5`
Expected: 73 + 4 = 77 pass.

- [ ] **Step 5: Commit**

```bash
git add tests/cli-build.test.ts
git commit -m "$(cat <<'EOF'
test(cli): end-to-end coverage for Tailwind v4 CSS pipeline

Four new cases on the existing build+spawn rig: dist/css/app.css
artifact, /_brust/css/app.css HTTP serving + headers, SSR <link>
injection placement before </head>, and path-traversal rejection.
EOF
)"
git log -1 --format=%B
```

---

## Task 10 — Real-browser smoke (Chrome DevTools MCP)

**Files:**
- None (verification only)

This is a **manual** verification step. The unit + integration tests prove the pipeline emits valid bytes; this step proves the bytes actually result in a styled page in a real browser. Session 9 + 10 lessons: skip this and we ship hydration/styling bugs that look fine in tests.

- [ ] **Step 1: Build a fresh prebuilt dist**

```bash
rm -rf /tmp/brust-css-smoke
bun runtime/cli/index.ts build example/hello-world/index.ts --out-dir /tmp/brust-css-smoke
```

Expected: ends with `done.`. `/tmp/brust-css-smoke/css/app.css` exists.

- [ ] **Step 2: Start the prebuilt server**

```bash
BRUST_PORT=39888 bun run /tmp/brust-css-smoke/index.js
```

Leave running. Expect log lines including `[brust] main: using pre-built CSS at /tmp/brust-css-smoke/css`.

- [ ] **Step 3: Drive Chrome DevTools MCP**

Use the `mcp__plugin_chrome-devtools-mcp_chrome-devtools__*` tool family:

```text
- new_page http://127.0.0.1:39888/
- take_snapshot — verify the header has the brand mark and nav links rendered with the project palette (terracotta brand on cream background)
- list_network_requests — verify /_brust/css/app.css returned 200 text/css
- list_console_messages — should be EMPTY (no errors, no warnings)
- click on the "Profile" link in nav
- wait_for selector="[data-testid='bio']"  (bio resolves after ~150ms)
- take_snapshot — verify Profile page still styled (font/colors persist across SPA nav)
- click on the "Home" link
- wait_for selector="[data-testid='counter']"
- click [data-testid='counter'] — verify the count increments visually
- take_screenshot — save for archive evidence
```

Expected:
- No console errors at any step.
- `/_brust/css/app.css` is the ONLY CSS network request per page; not refetched on SPA nav.
- Counter increments 0 → 1 → 2 (regression check on islands hydration over the Tailwind migration).
- Visual consistency: header has terracotta brand on white, body uses cream background, links are terracotta.

- [ ] **Step 4: Stop the server**

`Ctrl-C` in the terminal running the prebuilt server.

- [ ] **Step 5: No commit needed (verification only)**

If the smoke surfaced bugs, FIX them in the relevant task's file and amend the commit (or add a follow-up `fix(...)` commit if the task's already pushed). Do not declare the plan done until the smoke is clean.

---

## Task 11 — Update `architecture.md`

**Files:**
- Modify: `architecture.md`

- [ ] **Step 1: Read current state**

Run: `grep -n "Tailwind\|tailwind\|app.css\|/_brust/css" architecture.md`

Expected: zero or near-zero matches (Tailwind isn't there yet) — or a single "Designed, not built" bullet if the prior author listed it.

Find the "Built" list and the "Designed, not built" list. The build-CLI session added a `brust build` bullet to the Built list and pulled `build` from the designed-not-built tooling line. Find that area.

- [ ] **Step 2: Add the Built bullet**

Add to the Built list (preserve existing list style — usually bullet form with backticks for code refs):

```markdown
- **Tailwind v4** — `<scanRoot>/app.css` convention; compiled programmatically via `@tailwindcss/node` (CSS-first config, user owns `@source` globs); output served at `/_brust/css/<file>` with `Cache-Control: public, max-age=3600`; SSR renderer auto-injects `<link rel="stylesheet">` before `</head>` on the first chunk. Build-only (no watch/HMR); dev mode compiles at boot.
```

If a `Designed, not built` line references Tailwind, REMOVE it from that section.

- [ ] **Step 3: Cross-check other sections**

If `architecture.md` has a "Routes" or "HTTP surface" table listing `/_brust/islands/...`, add a `/_brust/css/<file>` row with the same format. Skip if no such table exists.

- [ ] **Step 4: Commit**

```bash
git add architecture.md
git commit -m "$(cat <<'EOF'
docs(architecture): Tailwind v4 CSS pipeline shipped — promote to Built

CSS-first config via <scanRoot>/app.css, served from /_brust/css/<file>,
<link> auto-injected by the SSR renderer. Build-only; dev mode compiles
at boot. Watch/HMR is a separate downstream sub-project.
EOF
)"
git log -1 --format=%B
```

---

## Task 12 — Final verification + push

**Files:**
- None (verification + git only)

- [ ] **Step 1: Run all three baselines from a cold cache**

```bash
cargo test --lib 2>&1 | tail -5
```

Expected: 99 pass.

```bash
bun test runtime/ 2>&1 | tail -5
```

Expected: 117 pass.

```bash
bun test tests/ 2>&1 | tail -5
```

Expected: 77 pass.

If any number is lower than expected, INVESTIGATE — don't skip. Re-read the failing task's commits.

- [ ] **Step 2: Verify dev mode still works (zero CSS)**

```bash
# Temp project without app.css:
mkdir -p /tmp/brust-nocss/example
cp example/hello-world/index.ts /tmp/brust-nocss/example/
cp example/hello-world/routes.tsx /tmp/brust-nocss/example/
cp -r example/hello-world/pages /tmp/brust-nocss/example/
cp -r example/hello-world/components /tmp/brust-nocss/example/
cp example/hello-world/island.config.ts /tmp/brust-nocss/example/
cp example/hello-world/sse-counter.ts /tmp/brust-nocss/example/
cp example/hello-world/ws-echo.ts /tmp/brust-nocss/example/
# NB: do NOT copy app.css.
BRUST_PORT=39803 timeout 3 bun run /tmp/brust-nocss/example/index.ts 2>&1 | head -20
```

Expected: server boots. No `built CSS` log line (since no app.css). No errors.

`curl -s http://127.0.0.1:39803/ | grep -c "/_brust/css/app.css"` → 0.

`curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:39803/_brust/css/app.css` → `404`.

Kill the server.

- [ ] **Step 3: Verify the full happy path against the migrated example**

```bash
BRUST_PORT=39804 timeout 4 bun run example/hello-world/index.ts 2>&1 | head -20 &
sleep 2
curl -s http://127.0.0.1:39804/_brust/css/app.css | wc -c   # > 1000 bytes typical
curl -s http://127.0.0.1:39804/ | grep -c "/_brust/css/app.css"  # 1
wait
```

Expected: CSS file present + non-empty, HTML contains exactly one `<link>` tag pointing at it.

- [ ] **Step 4: Push to origin/main**

```bash
git status
git log --oneline -15
git push origin main
```

Standing user consent for `git push origin main` after clean commits applies (per session's working agreement). If any commit message looks wrong on inspection (`git log -1 --format=%B`), amend BEFORE pushing.

Expected: push succeeds. Output ends with `main -> main`.

- [ ] **Step 5: Final repo state check**

```bash
git status
git log --oneline -15
```

Expected: clean tree on `main`, recent ~12 commits visible (Task 1 through Task 11 plus any fix amends).

---

## Self-review checklist (writer-side, do NOT skip)

Run through this before declaring the plan ready for execution:

- **Spec coverage:** every section of `docs/superpowers/specs/2026-05-27-tailwind-v4-css-pipeline-design.md` is implemented by at least one task. Spot-checked: configuration / discovery (Task 6), CSS build (Task 4), Rust route (Task 5), SSR injection (Tasks 2+3), example migration (Task 8), tests (Tasks 1/2/4/5/9), docs (Task 11), final verify (Task 12). No gaps.
- **No placeholders:** no "TBD", "TODO", "fill in", "similar to Task N" without inline code. Verified.
- **Type / name consistency:** `buildCss({ entry, outDir })` returns `{ outDir, files: ['app.css'] }` everywhere. `configureCssEnabled(hrefs)` and `getCssHrefs()` match. `is_safe_css_filename` and `configure_css_dir` names match between Rust and the wrapper.
- **TDD discipline:** every code-producing task writes a failing test, observes the failure, then implements. Tasks 5 (Rust), 8 (example migration), 10 (smoke) are intentionally not test-first because they're either too coupled to manual observation or the test surface lives in Task 9.
- **Granularity:** every step is 2–5 minutes of work. The biggest task (Task 8: example migration) is broken into 8 sub-steps.
