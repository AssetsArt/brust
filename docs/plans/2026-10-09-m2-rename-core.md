# M2c2 — rename `@brust/brust` → `@brust/core` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: `v2` @3a685a9

**Goal:** The user-facing package is `@brust/core` (human decision 2026-10-09: "`@brust/core/routes` would be much better than `@brust/brust/routes`"). Nothing is published yet, so this is a pure rename: npm name, every import specifier in code, fixtures and docs, and the two compiler sites that recognise framework imports. The directory stays `packages/brust` (every other plan cites it); only the name and specifiers change.

**Architecture:** mechanical. Compiler: `cache` is recognised from `@brust/core` (keep the bare `brust` specifier for the M1 fixtures; DROP `@brust/brust`, never published); `Outlet` from `@brust/core/routes`. Package: `name`, `exports` subpaths (`.`, `./routes`, `./server`, `./browser` — whatever `packages/brust/package.json` exports today), build externals (`@brust/core`, `@brust/core/*`), README, fixtures and tests. CI: any `@brust/brust` string in `.github/workflows/ci.yml`.

**Tech Stack:** Rust (two string literals + tests), TypeScript, JSON, YAML.

**Spec:** server spec S3 (package names) and S6 "Import specifiers" (the lead amends both in the same commit as this plan).

## Global Constraints

- No behaviour change: after the rename every existing test passes unchanged except for the specifier strings. `bun run battery` must produce no diff in `docs/`.
- No directory rename, no `bin` rename (`brust` stays the CLI name), no napi `packageName` change (`@brust/native` stays).
- Search, don't guess: finish with `grep -rn "@brust/brust" --exclude-dir=node_modules --exclude-dir=target --exclude-dir=.git .` returning ONLY lines inside `docs/` that the lead owns (the lead's commit already rewrote the live docs; historical plan files may keep the old name — list what remains in the task note).
- Boundary: `packages/brust/**`, `crates/brust-compiler/src/analyze/{component,jsx}.rs`, `crates/brust-compiler/src/ir/template.rs`, `crates/brust-compiler/tests/{cache,review_edges,jsx_reader}.rs`, `tests/fixtures/outlet-layout/**`, `.github/workflows/ci.yml`, `docs/plans/m1a-followups.md`. NOT `crates/brust-compiler/src/lower/**` (lane m2x owns it).
- Gates: `cargo fmt --all -- --check`, `cargo clippy --workspace --exclude bun_react_compiler --no-deps -- -D warnings`, `cargo test -p brust-compiler`, `cd packages/brust && bun test`, `bun run battery` twice + `git status --short docs/` empty, `bun run browser-test`.

## Review Focus

1. **A user who still writes `import { cache } from '@brust/brust'`**: the compiler must NOT recognise it (tier react with `default-export-shape`, as any unknown wrapper) — Task 1 pins it.
2. **`Outlet` from `@brust/core/routes` vs `@brust/core`**: only the `/routes` subpath is the intrinsic (matches the package's export map) — Task 1 pins both spellings.
3. **jobs/react bundles externalise `@brust/core` and `@brust/core/*`** (the m2c round-3 fix) — Task 2 re-runs `react-cache-start.test.ts` against the new name.
4. **Build-time server-only guard**: the `@brust/core` server entry must still be refused from browser bundles while `@brust/core/browser` (if present) is allowed — Task 2 re-runs `build-safety.test.ts`.
5. **Published-name consistency**: `packages/brust/package.json` `name`, `exports`, `bin`, napi `packageName`, and `optionalDependencies` (if any) agree — Task 2 adds one test asserting `name === '@brust/core'` and that every export key resolves.

---

### Task 1: Compiler specifiers

**Files:**
- Modify: `crates/brust-compiler/src/analyze/component.rs:194` (`Some(("brust" | "@brust/brust", "cache"))` → `Some(("brust" | "@brust/core", "cache"))`), `crates/brust-compiler/src/analyze/jsx.rs:45` (`"@brust/brust/routes"` → `"@brust/core/routes"`), `crates/brust-compiler/src/ir/template.rs` (the string there — read the line; it is likely the Outlet diagnostic/remediation text), `tests/fixtures/outlet-layout/input.tsx` (import), goldens regenerate only if the remediation text is in a golden
- Test: `crates/brust-compiler/tests/cache.rs` (`cache_from_the_brust_package_is_recognised_and_others_are_not`: table becomes `("brust", true), ("@brust/core", true), ("@brust/brust", false), ("./cache", false), ("react", false)`), `crates/brust-compiler/tests/review_edges.rs` and `jsx_reader.rs` (Outlet tests: `@brust/core/routes` recognised; `@brust/core` (no subpath) and `@brust/brust/routes` NOT)

- [ ] **Step 1**: update the three tests first; run `cargo test -p brust-compiler --test cache --test jsx_reader --test review_edges` → the new rows fail.
- [ ] **Step 2**: change the two literals (+ the `ir/template.rs` text), fix the fixture import, `BRUSTC_UPDATE=1 cargo test -p brust-compiler --test fixtures` only if a golden holds the old string (inspect the diff: text only).
- [ ] **Step 3**: `cargo test -p brust-compiler` green; commit `refactor(compiler): framework imports are @brust/core and @brust/core/routes`.

---

### Task 2: Package rename

**Files:**
- Modify: `packages/brust/package.json` (`name: "@brust/core"`), `packages/brust/src/{browser,build/bundle,build/index,cache-core,index,native,routes,server}.ts` (every `'@brust/brust…'` string: externals, resolve guards, error messages, doc comments), `packages/brust/README.md`, `packages/brust/test/**` (all fixture imports and assertions listed by the grep in the lead's task note), `.github/workflows/ci.yml` (the one string), root `package.json`/`bun.lock` if the workspace references the name
- Test: `packages/brust/test/package-name.test.ts` (new, Review Focus 5)

- [ ] **Step 1**: `grep -rn "@brust/brust" packages .github package.json | grep -v node_modules` → paste the count in the task note (expected ≈ 45 lines).
- [ ] **Step 2**: replace; `bun install` at the root so the workspace link follows the new name (`node_modules/@brust/core`); verify `ls node_modules/@brust/`.
- [ ] **Step 3**: new test:
```ts
import { expect, test } from 'bun:test'
import pkg from '../package.json'
test('published name and exports agree', () => {
  expect(pkg.name).toBe('@brust/core')
  for (const key of Object.keys(pkg.exports)) expect(() => Bun.resolveSync(`@brust/core${key.slice(1)}`, import.meta.dir)).not.toThrow()
})
```
- [ ] **Step 4**: `cd packages/brust && bun test` green (incl. `react-cache-start`, `build-safety`, e2e); commit `refactor(brust): package is @brust/core`.

---

### Task 3: Ledger and leftovers

- [ ] `grep -rn "@brust/brust" --exclude-dir=node_modules --exclude-dir=target --exclude-dir=.git .` → list remaining hits in the task note (historical plan files are acceptable; anything under `packages/`, `crates/`, `tests/`, `.github/` is not).
- [ ] Ledger row **F65**: "package renamed to `@brust/core` before first publish; bare `brust` specifier kept for M1 fixtures only — drop at M3" owner M3. Commit `docs: ledger F65 (package rename)`.

## Verification (READY evidence, paste in the task note)

```
grep -rn "@brust/brust" packages crates tests .github package.json | grep -v node_modules | wc -l   # 0
cargo test -p brust-compiler && cd packages/brust && bun test
bun run battery && bun run battery && git status --short docs/ && bun run browser-test
```
PR `lane/m2c2-rename-core` → `v2`, CI green (all jobs), lane HEAD sha.

## Dispatch table (for the Coordinator)

| slug | plan tasks | tier | role | deps | review | acceptance (READY evidence) |
|---|---|---|---|---|---|---|
| `m2c2-rename-core` | 1–3 | routine | Implementer (Routine) | none (parallel to m2x; disjoint boundary) | standard | Verification block pasted (grep count 0); PR → `v2` CI green; lane HEAD sha |
