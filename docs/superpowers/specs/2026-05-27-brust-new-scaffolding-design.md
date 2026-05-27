# `brust new` Scaffolding — Design

**Date:** 2026-05-27
**Status:** Designed, awaiting plan
**Scope:** New CLI subcommand `brust new <name>` that scaffolds a working brust app into a fresh directory: one template, one motion, opinionated defaults. Output mirrors `example/hello-world` (Tailwind v4 + one island + one route) but stripped of the demo variety so a new user has the smallest possible starting surface.

---

## Goal

Make starting a new brust app a one-liner. After:

```bash
bunx brust new my-app
cd my-app
bun install
bun run dev
```

…the user has a browser tab on `http://127.0.0.1:3000`, Tailwind compiled, one hydrated island clicking, and the project tree ready to extend. The whole flow should take under a minute on a warm cache.

**Critical constraints:**
- The scaffolded app boots on `bun run dev` with no edits.
- `bun run build` produces a working `dist/` (per the existing build CLI).
- When the CLI runs from the brust source tree (this repo), the emitted `package.json` references brust via `file:<abspath>` so the new project installs against the local source — this is the only way `brust new` is testable end-to-end before brust ships to npm.
- When the CLI runs from an installed `brust` package (future bunx case), it emits a version reference (`"brust": "^X.Y.Z"`).

---

## Non-goals

- Multiple templates (`--template <minimal|tailwind|full-demo>`). One template only.
- Interactive prompts (TTY questions). All input via positional arg + flags.
- `git init` inside the scaffolded dir. User can run it.
- JavaScript-only variant (no `.js`/`.jsx` template path). TypeScript everywhere.
- Choosing feature opt-ins (`--no-tailwind`, `--no-islands`). The template is fixed.
- Auto-running `bun install` after scaffold. We print the command, user runs it.
- Auto-opening the browser. Out of scope for this CLI.
- Publishing brust to npm (separate workstream — this spec just leaves room).
- Project name validation beyond "non-empty + filesystem-safe + doesn't contain `..`". We do not enforce npm naming rules.
- Cross-template upgrade path (no `brust upgrade`).

---

## High-level architecture

```
brust new <name>
─────────────────────────────────────────────────────────────
runtime/cli/index.ts             ← add `case 'new'` dispatch
runtime/cli/new.ts::runNew(args) ← orchestrator
  ├─ parseArgs(args)             → { projectName, targetDir }
  ├─ validateTarget(targetDir)   → throws if exists+non-empty / unsafe
  ├─ resolveBrustRef()           → { kind:'file'|'version', value:string }
  ├─ copyTemplate({
  │     templateDir: <repo>/runtime/cli/templates/minimal,
  │     targetDir,
  │     substitutions: {
  │       __PROJECT_NAME__: projectName,
  │       __BRUST_DEP__:    JSON.stringify(brustRef.spec),
  │     },
  │   })
  └─ printNextSteps(projectName)


TEMPLATE LAYOUT (committed to repo):
─────────────────────────────────────────────────────────────
runtime/cli/templates/minimal/
├── _gitignore            ← renamed to .gitignore on emit. Defensive rename:
│                            npm publish strips top-level .gitignore from packed
│                            tarballs; Bun's bundler/install path is not
│                            documented to do the same but may. Using `_gitignore`
│                            as the source name is cheap insurance. This repo is
│                            currently `private: true` so there's no packed dist
│                            yet to verify against; revisit if/when brust
│                            publishes and templates ship inside the tarball.
├── package.json.tmpl     ← contains __PROJECT_NAME__ + __BRUST_DEP__
├── tsconfig.json
├── index.ts
├── routes.tsx
├── island.config.ts
├── app.css
├── README.md.tmpl        ← contains __PROJECT_NAME__
├── pages/
│   └── Home.tsx.tmpl     ← contains __PROJECT_NAME__
└── components/
    ├── Layout.tsx
    └── Counter.tsx
```

`.tmpl` suffix marks files that contain placeholders; the suffix is stripped at emit. Files without `.tmpl` are copied byte-for-byte. **The `.tmpl` suffix is the ONLY way `runNew` decides whether to run substitution** — any template file containing a placeholder MUST have the suffix. Files in this design that need substitution: `package.json.tmpl`, `README.md.tmpl`, `pages/Home.tsx.tmpl`.

---

## CLI surface

```
brust new <name> [--dir <path>]
```

| Arg / flag | Default | Notes |
|---|---|---|
| `name` (positional) | _required_ | Project name. Becomes `package.json` name and (by default) the target directory under cwd. Validation: matches `/^[a-z0-9][a-z0-9_-]*$/` (lowercase, alnum + `-` `_`, must start alnum). Anything else exits 1 with a clear error. |
| `--dir <path>` | `./<name>` (cwd) | Override target directory. Absolute or relative. Useful for `brust new my-app --dir .` to scaffold into the current directory. |

**Behavior:**
- Target directory may not exist OR may exist-but-empty. Existing non-empty dirs exit 1 with a message naming the dir.
- On success: emit files, print 3-line next-steps block, exit 0.
- On any error during emission: best-effort cleanup of partial dir (only if we created it), then exit 1.

No other flags in MVP. Future expansion (`--template`, `--no-install`, etc.) is intentionally deferred.

---

## File structure

**New files in the brust repo:**

| File | Responsibility |
|---|---|
| `runtime/cli/new.ts` | Orchestrator. Exports `runNew(args: string[]): Promise<void>`. Parses, validates, resolves brust ref, copies template, prints next steps. ~120 LOC. |
| `runtime/cli/templates/minimal/_gitignore` | Will become `.gitignore` in scaffolded project. Ignores `node_modules/`, `.brust/`, `dist/`, `brust.toml`. |
| `runtime/cli/templates/minimal/package.json.tmpl` | Project package.json. Sets name, scripts (`dev`, `build`), deps (`brust`, `react`, `react-dom`), devDeps (`@types/bun`, `@types/react`, `@types/react-dom`, `typescript`). |
| `runtime/cli/templates/minimal/tsconfig.json` | Concrete contents pinned: `compilerOptions` = `{ lib:["ESNext"], target:"ESNext", module:"Preserve", moduleDetection:"force", jsx:"react-jsx", allowJs:true, types:["bun"], moduleResolution:"bundler", allowImportingTsExtensions:true, verbatimModuleSyntax:true, noEmit:true, strict:true, skipLibCheck:true, noFallthroughCasesInSwitch:true, noUncheckedIndexedAccess:true, noImplicitOverride:true }`. No `exclude` field (template projects have no `target/`). |
| `runtime/cli/templates/minimal/index.ts` | 3-line entry: `import { brust } from 'brust'; import { routes } from './routes'; await brust.run({ routes, entry: import.meta.url })`. |
| `runtime/cli/templates/minimal/routes.tsx` | One route `/ → Home`. Uses `defineRoutes` from `'brust/routes'` (or whatever the published path becomes). |
| `runtime/cli/templates/minimal/island.config.ts` | One island map entry for `Counter`. |
| `runtime/cli/templates/minimal/app.css` | `@import "tailwindcss"; @source "./**/*.{tsx,ts}";` — just enough to make Tailwind classes work. |
| `runtime/cli/templates/minimal/README.md.tmpl` | Quickstart: `bun install`, `bun run dev`, `bun run build`. Plus a one-paragraph "what this is" pointer to the brust docs. |
| `runtime/cli/templates/minimal/pages/Home.tsx.tmpl` | Renders `<Layout>` + a paragraph + `<Island component={Counter} />`. Contains `__PROJECT_NAME__` (in the `<Layout title=…>`). Emitted as `pages/Home.tsx`. |
| `runtime/cli/templates/minimal/components/Layout.tsx` | Minimal `<html><head><body>` shell with `<title>` and a header. No nav (no other routes). |
| `runtime/cli/templates/minimal/components/Counter.tsx` | Same shape as the demo Counter — `useState`, single button, Tailwind classes. |
| `tests/cli-new.test.ts` | Integration test (see Tests section). |

**Modified files:**

| File | Change |
|---|---|
| `runtime/cli/index.ts` | Add `case 'new'` → dynamic-import `./new.ts`, call `runNew(rest)`. Update default error message to include `new`. |

**Re-exports needed in the brust package surface (so templates can use `from 'brust'`):**

This depends on how brust exposes itself today. The example app imports `from '../../runtime/index.ts'` (relative). For the template to do `from 'brust'`, the package needs:
- `package.json`'s `main` / `exports` to point at `runtime/index.ts` (or a built artifact)
- A subpath export for `defineRoutes`: `from 'brust/routes'` resolves to `runtime/routes.ts`

The current `package.json` only has `"module": "index.ts"` (which points at a non-existent file at repo root — the real entry is `runtime/index.ts`) and no `exports` field. **This spec scopes in the minimum package-exports work needed for the template to resolve**: add an `exports` map to root `package.json` with at least `'.'` → `./runtime/index.ts`, `'./routes'` → `./runtime/routes.ts`, and remove the stale `"module": "index.ts"` line. We do NOT do a broader API export audit in this spec — additional subpaths can be added in follow-ups if the template grows.

**React peer-dependency adjustment (required, in scope):**

`architecture.md` warns that a dual React copy (one pulled in by brust, one declared in the user's project) causes a dispatcher-null SSR crash. Root `package.json` currently lists `react` and `react-dom` as `dependencies`, which would create exactly that dual copy when a scaffolded project also declares them. **In scope for this spec:** move `react` and `react-dom` in root `package.json` from `dependencies` → `peerDependencies` (keeping the same version range), so the scaffolded project's direct deps remain the only physical copies. Brust's own dev workflow (`bun run dev` in this repo) is unaffected because the root `node_modules` still resolves them via dev-time install.

If this move turns out to break this repo's own build/dev for any reason discovered at implementation time, fall back to: keep root deps as-is, drop `react`/`react-dom` from the template's `dependencies`, and document that they flow transitively through brust. Pick the peer-deps path by default.

---

## Brust dependency resolution

The trickiest single decision. `runtime/cli/new.ts::resolveBrustRef()` returns one of:

1. **`{kind:'file', value:'file:<abspath>'}`** — when the CLI is running from the brust source tree. Detect by walking up from `import.meta.dir` until we find a `package.json` whose `name === 'brust'` AND the directory also contains `Cargo.toml`, `src/`, and `runtime/cli/index.ts` (three markers — the third is what distinguishes a real checkout from a hypothetical monorepo workspace package with the same name but no CLI). If found, use that absolute path.
2. **`{kind:'version', value:'^<version>'}`** — fallback when source markers are not all present but the upward-walk still found a `name === 'brust'` package.json. Read the version from it.
3. **Hard error** — if no `package.json` named `brust` is found in any ancestor of the CLI install location, exit 1 with: `brust new: cannot locate the brust package — is your installation intact?` This should be unreachable in practice (the CLI ships inside the brust package) but is the safe failure mode.

Worktree-aware: a git worktree of this repo still has `Cargo.toml`, `src/`, and `runtime/cli/index.ts` in its own working tree (only `.git` is shared), so the file: path correctly resolves to the worktree root, not the primary checkout. Symlinked installs (`bun link`) follow the same rule since `import.meta.dir` reflects the resolved path Bun chose.

The resolved spec gets JSON-stringified and substituted into `package.json.tmpl`'s `__BRUST_DEP__` placeholder.

**Why this works for tests:** the test suite runs from the repo, so the resolved ref is `file:/abs/path/to/brust`. Running `bun install` inside the scaffolded project resolves brust against the live source. We don't need a published package to smoke-test end-to-end.

**What happens after brust publishes:** the version-ref branch kicks in automatically for `bunx brust new` invocations from outside the source tree. No code change.

**Future polish (not in this spec):** allow `BRUST_NEW_DEP_OVERRIDE=foo:bar` env var to force a spec for test scenarios.

---

## Template content sketches

Each template file is short enough to embed here for review. The exact wording may shift during implementation but the shape is fixed.

### `package.json.tmpl`
```json
{
  "name": "__PROJECT_NAME__",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "brust dev",
    "build": "brust build"
  },
  "dependencies": {
    "brust": __BRUST_DEP__,
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "typescript": "^5.5.0"
  }
}
```

### `index.ts`
```ts
import { brust } from 'brust'
import { routes } from './routes'

await brust.run({ routes, entry: import.meta.url })
```

### `routes.tsx`
```tsx
import { defineRoutes } from 'brust/routes'
import Home from './pages/Home'

export const routes = defineRoutes([
  { path: '/', Component: Home },
])
```

### `island.config.ts`
```ts
export default {
  islands: {
    Counter: './components/Counter.tsx',
  },
}
```

### `app.css`
```css
@import "tailwindcss";
@source "./**/*.{tsx,ts}";

@theme {
  --color-brand: #2563eb;
}
```

### `pages/Home.tsx`
```tsx
import { Island } from 'brust'
import Layout from '../components/Layout'
import Counter from '../components/Counter'

export default function Home() {
  return (
    <Layout title="__PROJECT_NAME__">
      <h1 className="text-3xl font-bold mb-4">Welcome to brust</h1>
      <p className="mb-4 text-gray-700">
        Edit <code className="bg-gray-100 px-1 rounded">pages/Home.tsx</code> and save —
        <code className="bg-gray-100 px-1 rounded ml-1">brust dev</code> will reload.
      </p>
      <Island component={Counter} props={{ start: 0, label: 'clicks' }} hydrate="load" />
    </Layout>
  )
}
```

(Note: `__PROJECT_NAME__` substitution applies here too.)

### `components/Layout.tsx`
```tsx
import type { ReactNode } from 'react'

export default function Layout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
      </head>
      <body className="bg-white text-gray-900 font-sans">
        <main className="max-w-3xl mx-auto px-5 py-8">{children}</main>
      </body>
    </html>
  )
}
```

### `components/Counter.tsx`
```tsx
import { useState } from 'react'

export default function Counter({ start = 0, label = 'count' }: { start?: number; label?: string }) {
  const [n, setN] = useState(start)
  return (
    <button
      onClick={() => setN(n + 1)}
      className="px-3 py-1.5 bg-brand text-white rounded text-sm hover:opacity-90 transition-opacity"
    >
      {label}: {n}
    </button>
  )
}
```

### `_gitignore`
```
node_modules/
.brust/
dist/
brust.toml
```

### `README.md.tmpl`
```markdown
# __PROJECT_NAME__

Scaffolded with `brust new`.

## Develop

    bun install
    bun run dev

Open http://127.0.0.1:3000.

## Build

    bun run build

Outputs a standalone `dist/` you can ship — `bun run dist/index.js` boots the server.
```

---

## Validation rules

| Concern | Rule | Behavior |
|---|---|---|
| Project name format | `/^[a-z0-9][a-z0-9_-]*$/` | Reject with: `brust new: invalid project name "<value>" — use lowercase letters, digits, hyphens, underscores; must start with a letter or digit`. |
| Project name length | ≤ 50 chars | Reject with: `brust new: project name too long (max 50 chars)`. |
| Target dir exists | If exists, must be empty (no entries) | Reject with: `brust new: target directory "<path>" is not empty`. |
| Target dir creation | Best-effort `mkdir -p` | If creation fails (permission, path inside read-only fs), bubble the error message. |
| `--dir .` (cwd) | Allowed if cwd is empty | Same empty-dir rule. |
| Template files missing | Should not happen in shipped CLI; if `templates/minimal/` is gone, exit 1 with a "did your install break?" message | n/a |

We do not validate that `node`/`bun` are installed — the next-steps print is informational.

---

## Output: next-steps block

After successful emission, print exactly:

```
Created __PROJECT_NAME__ at <abspath>

Next:
  cd <abspath relative to cwd if shorter, else absolute>
  bun install
  bun run dev
```

No emoji. No color. Matches the terse style of existing brust CLI output.

---

## Error semantics

| Failure mode | Exit code | stderr message |
|---|---|---|
| Missing project name | 1 | `brust new: missing project name. Usage: brust new <name> [--dir <path>]` |
| Unknown flag | 1 | `brust new: unknown flag "<flag>"` |
| `--dir` without value | 1 | `brust new: --dir requires a value` |
| Invalid project name | 1 | (per validation rules above) |
| Target dir not empty | 1 | (per validation rules above) |
| Template directory missing | 1 | `brust new: template directory not found at <path>; this is a brust installation bug` |
| Copy / write error (any other) | 1 | `brust new: failed to scaffold (<reason>)` + best-effort cleanup |

Best-effort cleanup means: if `runNew` created the target dir itself and is mid-copy when an error fires, `rm -rf` the target dir before exiting. If the target dir pre-existed (the empty-dir-allowed path), leave it alone — never delete a dir we did not create.

---

## Tests

All in `tests/cli-new.test.ts`. Pattern matches existing `tests/cli-build.test.ts`.

### Required scenarios

1. **Happy path — scaffold + install + boot + curl.** Most expensive test, runs last.
   - **Prerequisite:** the brust native `.node` binary must already be built in the repo (`runtime/*.node` exists). The test harness checks for it and skips with a clear `console.warn` if missing; CI must run `cd runtime && bun run build` before this test file.
   - `mkdtemp` a parent dir
   - `bun runtime/cli/index.ts new test-app --dir <tmpparent>/test-app`
   - Verify file tree (every expected file exists, including the renamed `.gitignore` and the `.tmpl`-stripped `Home.tsx`)
   - Verify `package.json` contents: `name === 'test-app'`, `dependencies.brust` starts with `file:` AND points at the repo root, all expected scripts present
   - Verify `__PROJECT_NAME__` substituted everywhere (grep for the literal string `__PROJECT_NAME__` and `__BRUST_DEP__` in every emitted file — should be zero matches)
   - `bun install` inside the new project (allow ~30s)
   - **Boot via `bun run dev`** from inside the scaffolded project. This exercises the `scripts.dev` → `brust dev` → `node_modules/.bin/brust` → `runtime/cli/index.ts` resolution chain end-to-end. Pass `BRUST_PORT=<test-port>` via env so the test can use a non-default port.
   - Wait for port, curl `/`, expect `200` + body containing `Welcome to brust`
   - Tear down: SIGINT the proc, rm the tmp parent

2. **`--dir .` into an empty cwd.**
   - `mkdtemp`, `process.chdir`, run `brust new foo --dir .`, verify files land at cwd root.

3. **Existing non-empty dir → exit 1.**
   - Pre-create target with a file in it. Run `brust new foo`. Expect `exitCode === 1`, stderr contains `not empty`.

4. **Invalid project name → exit 1.**
   - Cases: `Foo` (uppercase), `1-foo` is OK (digit start allowed), `-foo` (starts with hyphen — rejected), `foo bar` (space), empty string (counts as missing).

5. **Missing project name → exit 1.**
   - `bun runtime/cli/index.ts new`. Stderr contains `missing project name`.

6. **No substitution leakage.**
   - After scaffold, no file under the new dir contains the literal `__PROJECT_NAME__` or `__BRUST_DEP__`.

### Test budget
Test #1 is heavy (`bun install` + worker boot). Target ≤ 90s total. Don't gate on Tailwind compilation in this test — the existing build test already covers that. Just verify the route serves HTML containing the welcome string.

### Unit-ish tests
Skip a dedicated unit test for `resolveBrustRef`. It's covered transitively by test #1 (the resolved spec ends up in the emitted package.json, which we assert on).

---

## Acceptance criteria

The implementation is done when:

1. `bun runtime/cli/index.ts new my-app` (run from this repo) creates `./my-app/` with all expected files.
2. `cd my-app && bun install` succeeds against the file: ref.
3. `cd my-app && bun run dev` (which resolves the `brust` bin from `node_modules/.bin/brust`) boots, serves `/`, returns HTML with the Counter island. The test harness exercises this exact motion.
4. All 6 test scenarios pass.
5. `architecture.md` gains a "Built — `brust new` scaffolding" bullet under the existing Built list.

---

## Open questions for plan-time

1. Does the template need to ship `mcp-routes.ts` or any agentic surface stub? Current answer: **no** — keep MVP narrow. Mention `architecture.md` for what's possible.
2. Should `package.json` `scripts.dev` invoke `brust dev` or `bun runtime/cli/index.ts dev`? Current answer: `brust dev`, relying on the `bin` entry of the brust package resolving via `bun run`. This will Just Work once the new project has `brust` installed (file: ref points at this repo, which has the bin in its `package.json`).
3. Should we add a `bunfig.toml` to the template? Current answer: **no** — Bun's defaults are fine.
4. Should we ship a `brust.example.toml` in the template? Current answer: **no** — the framework defaults (port 3000, auto worker count) are right for a quickstart. A user who wants the config can copy from this repo's example.
