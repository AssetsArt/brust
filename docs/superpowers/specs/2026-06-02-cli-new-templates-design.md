# Spec — Interactive `brust new` with template selection

**Date:** 2026-06-02 · **Branch:** `feat/cli-new-templates` · **Status:** design

## Goal

`brust new` (and `bun create brustjs`) currently scaffolds exactly one template
(`runtime/cli/templates/minimal`), hardcoded. This adds **template selection**:

1. A registry of named templates.
2. An **interactive picker** (numbered list) shown when stdin is a TTY and no
   template was specified on the command line.
3. A `--template <name>` / `--template=<name>` flag for non-interactive use
   (CI, scripts, `bun create brustjs`), plus `--yes`/`-y` to take the default
   without prompting.
4. Two shipped templates:
   - **`minimal`** — the existing starter (unchanged behavior).
   - **`pokedex`** — the full dogfood app at `example/pokedex`, scaffolded with
     `FRAMEWORK-GAPS.md` and `README.md` **excluded** and a synthesized
     `package.json`, `tsconfig.json`, and `.gitignore` **added** (the in-repo
     copy lacks them because it lives inside the brust workspace).

Default template = `minimal` (keeps every existing test and `bun create`
invocation working byte-for-byte).

## Non-goals

- No new third-party prompt dependency. Use Bun's built-in global `prompt()`.
- No arrow-key/fuzzy TUI picker — a numbered list read from stdin is enough.
- No change to `minimal`'s emitted output (the existing scaffold test is the
  contract; it must keep passing unchanged).
- No physical mutation of `example/pokedex` (no committing a `package.json`
  into it — that would make Bun treat it as a separate workspace package and
  could break `bun run dev`). The pkg.json/tsconfig/.gitignore are **synthesized
  at scaffold time**, not stored in the example.
- No boot-test of the scaffolded pokedex (`bun install` + `bun run dev`) — the
  dual-React `file:` limitation documented in the existing scaffold test applies
  identically here. Out of scope.

## High-level architecture

### Template registry

A data-driven registry, new module `runtime/cli/templates.ts`:

```ts
export interface TemplateDef {
  name: string                 // 'minimal' | 'pokedex' — picker key + --template value
  title: string                // short label for the picker
  description: string          // one-line summary for the picker
  sourceDir: string            // absolute path to the source tree
  exclude: Set<string>         // POSIX-relative paths (from sourceDir) to skip when copying
  extraFiles?: (ctx: ScaffoldCtx) => EmittedFile[]  // files the source lacks, generated at scaffold time
}

export interface ScaffoldCtx {
  projectName: string
  brustRef: BrustRef           // resolved file:/version spec (existing type)
}

export interface EmittedFile {
  relPath: string              // POSIX-relative destination path
  content: string
}

export function listTemplates(): TemplateDef[]
export function getTemplate(name: string): TemplateDef | undefined
export const DEFAULT_TEMPLATE = 'minimal'
```

`sourceDir` resolution:
- `minimal` → `join(import.meta.dir, 'templates', 'minimal')` (inside `runtime/cli/`).
- `pokedex` → `join(packageRoot, 'example', 'pokedex')`, where `packageRoot` is
  the directory of the nearest `package.json` whose `name === 'brustjs'`. This
  is the **same walk** `resolveBrustRef` already performs; we extract it into a
  shared `findBrustPackageRoot(startDir): string` helper so source-tree and
  published-package layouts both resolve correctly (the published tarball ships
  `example/pokedex`, see Distribution).

### pokedex synthesized files (`extraFiles`)

`pokedex.extraFiles(ctx)` returns:

1. **`package.json`** — built from a template literal, NOT copied from minimal,
   because pokedex's dependency set differs:
   - `dependencies`: `brustjs` (`ctx.brustRef.spec`), `react`, `react-dom`, `zod`.
     **No `tailwindcss`** — pokedex's `app.css` is a hand-written design system
     that deliberately avoids Tailwind (verified: the only `tailwindcss` mention
     in `app.css` is a comment explaining its absence; no `@import "tailwindcss"`).
   - `devDependencies`: `@types/bun`, `@types/react`, `@types/react-dom`, `typescript`.
   - `scripts`: `dev: "brustjs dev"`, `build: "brustjs build"`.
   - version pins mirror `minimal/package.json.tmpl` (react `^19.2.6`,
     react-dom `^19.2.6`, types/typescript matching), `zod` `^4.4.3` (mirrors the
     workspace root pin).
2. **`tsconfig.json`** — read verbatim from `minimal/tsconfig.json` (single
   source of truth; pokedex uses the identical TS config).
3. **`.gitignore`** — read verbatim from `minimal/_gitignore`.

minimal has `extraFiles` undefined (it already carries these files).

### Scaffold engine

`copyTemplate` (existing) is generalized to accept `exclude` and `extraFiles`:

```ts
export interface CopyTemplateOpts {
  templateDir: string
  targetDir: string
  substitutions: Record<string, string>
  exclude?: Set<string>          // NEW — POSIX-relative paths to skip
  extraFiles?: EmittedFile[]     // NEW — written after the copy, never substituted
}
```

- `copyDir` is threaded a running POSIX-relative path so `exclude` can match
  `FRAMEWORK-GAPS.md` and `README.md` at the tree root. Matching is by exact
  relative path (forward-slash), so nested files of the same basename are safe.
- `extraFiles` are written after the directory copy. Their content is written
  **as-is** (the `package.json` is already fully substituted by its builder; we
  do not run `applySubstitutions` over `extraFiles`, avoiding accidental
  placeholder collisions in, e.g., source that legitimately contains `__`).
- `extraFiles` must not collide with copied files (enforced by registry design,
  not runtime check — pokedex source has no package.json/tsconfig/.gitignore).

### Template selection flow (`runNew`)

```
parseArgs(args) -> { projectName, targetDir, template?, yes }
  --template <name> / --template=<name>  -> template (validated against registry)
  --yes / -y                              -> yes = true
  (unknown --flag still throws as today)

selectTemplate({ explicit, yes, isTTY, read }) -> TemplateDef
  if explicit:           getTemplate(explicit) or throw "unknown template"
  else if yes:           DEFAULT_TEMPLATE
  else if isTTY:         promptPicker(listTemplates(), read)   // numbered list
  else:                  DEFAULT_TEMPLATE                       // non-TTY (CI, pipes)
```

`selectTemplate` takes an injected `read: () => string | null` (defaults to the
global `prompt`) and `isTTY` (defaults to `process.stdin.isTTY`) so it is unit
testable without a real terminal. `promptPicker` prints the numbered list, reads
one line, accepts a 1-based index or the template name, re-prompts on invalid
input (bounded to a few attempts, then falls back to default), and treats empty
input as "default".

## CLI / API surface

```
brust new <name> [--dir <path>] [--template <name>] [--yes]

  --template, -t <name>   Template to scaffold (minimal | pokedex).
                          If omitted and stdin is a TTY, you'll be prompted.
                          If omitted and non-interactive, defaults to minimal.
  --yes, -y               Skip the prompt; use the default template (minimal).
  --dir <path>            Target directory (default: ./<name>).
```

Interactive session:

```
$ brust new my-app
Select a template:
  1) minimal — Minimal starter: native route + island counter
  2) pokedex — Full PokéDex demo: native routes, loaders, islands, team store
Template [1]: 2
Created my-app at /abs/my-app (template: pokedex)
...
```

`printNextSteps` gains the selected template name in its "Created …" line.

`renderCommandHelp('new')` in `help.ts` is updated to document `--template`,
`-t`, and `--yes`.

## Distribution (npm packaging)

The published `brustjs` tarball currently ships `runtime/` only (`files` field).
For the published CLI to scaffold `pokedex`, `example/pokedex` must be in the
tarball. Add to `package.json` `files`:

```
"example/pokedex",
"!example/pokedex/FRAMEWORK-GAPS.md",
"!example/pokedex/README.md",
"!example/pokedex/.brust",
"!example/pokedex/dist",
"!example/pokedex/node_modules"
```

(Negation entries mirror the existing `"!runtime/node_modules"` style. The
`FRAMEWORK-GAPS.md`/`README.md` exclusions keep internal docs out of the tarball;
they are *also* excluded at scaffold time by the registry, which is the
authoritative exclusion — the `files` entries are purely tarball hygiene.)

`findBrustPackageRoot` resolves `example/pokedex` relative to the brustjs
package root in both layouts:
- **Source tree:** root has `Cargo.toml` + `example/pokedex` → resolves there.
- **Published install:** `node_modules/brustjs/example/pokedex` ships in the
  tarball → resolves there.

If the resolved pokedex `sourceDir` does not exist (corrupt install), scaffolding
that template throws a clear "template source not found — installation may be
incomplete" error (mirrors the existing missing-template-dir error in
`copyTemplate`).

## File structure

```
runtime/cli/
  templates.ts        NEW — registry, findBrustPackageRoot, pokedex extraFiles builder
  new.ts              MODIFIED — parseArgs(+template,+yes), selectTemplate, copyTemplate(+exclude,+extraFiles), runNew wiring
  help.ts             MODIFIED — `new` command help text
tests/
  cli-new.test.ts     MODIFIED — new cases (see Tests)
package.json          MODIFIED — files: add example/pokedex (+negations)
docs/superpowers/specs/2026-06-02-cli-new-templates-design.md   NEW (this file)
docs/superpowers/plans/2026-06-02-cli-new-templates-plan.md     NEW (Phase 4)
```

## Tests (`tests/cli-new.test.ts`, Bun test)

Existing tests stay green unchanged (default template = minimal). New cases:

**parseArgs**
- `--template pokedex` → `template === 'pokedex'`
- `--template=pokedex` → `template === 'pokedex'`
- `-t minimal` → `template === 'minimal'`
- `--template` with no value → throws `/--template requires a value/`
- `--yes` / `-y` → `yes === true`
- positional name still parsed alongside `--template`

**registry (`templates.ts`)**
- `listTemplates()` returns minimal + pokedex
- `getTemplate('pokedex')` defined; `getTemplate('bogus')` undefined
- `getTemplate('pokedex').sourceDir` exists on disk and contains `routes.tsx`

**selectTemplate (injected read/isTTY — no real terminal)**
- explicit valid name → that template
- explicit invalid name → throws `/unknown template/`
- no explicit + `yes` → minimal
- no explicit + non-TTY → minimal
- no explicit + TTY + read returns `"2"` → pokedex
- no explicit + TTY + read returns `""` → minimal (default)
- no explicit + TTY + read returns template name `"pokedex"` → pokedex

**copyTemplate**
- existing `.tmpl`/`_gitignore`/recursion tests unchanged
- `exclude` set skips listed root files; nested files of same basename survive
- `extraFiles` written verbatim (no substitution applied to their content)

**brust new pokedex scaffold (subprocess, `--template pokedex`, non-interactive)**
- exits 0
- emits `package.json` (name === project, deps include `brustjs`+`react`+`react-dom`+`zod`, **no** `tailwindcss`), `tsconfig.json`, `.gitignore`,
  `routes.tsx`, `index.ts`, `pages/`, `components/`, `lib/`, `actions.ts`, `app.css`
- does **NOT** emit `FRAMEWORK-GAPS.md` or `README.md`
- no `__PROJECT_NAME__` / `__BRUST_DEP__` leakage anywhere
- no `from 'brust'` (bare) imports — only `brustjs`/`brustjs/...`
- `package.json` `brustjs` dep is `file:` in source-tree test run, pointing at a
  dir containing `Cargo.toml`

**default still minimal (subprocess, no --template, non-TTY)**
- `brust new <name> --dir <tmp>` with piped stdin → emits the minimal tree
  (tailwindcss present, Home.tsx native) — i.e., the existing scaffold test,
  reasserted to lock the non-TTY default.

## Acceptance criteria

1. `bun test tests/cli-new.test.ts` green (existing + new cases).
2. `bun run ci` (biome) clean on changed TS.
3. `cargo`-side untouched (no Rust changes) — but full `bun test` and the
   release-gate baselines (`cargo test`, clippy, fmt, runtime, native-island{,-ssr},
   integration, cli-build) re-run in Phase 6 and unchanged from main.
4. Manual smoke: `brust new demo --template pokedex --dir <tmp>` produces a tree
   without FRAMEWORK-GAPS.md/README.md and with a synthesized package.json
   (deps incl zod, no tailwind).
5. `brust new demo --dir <tmp>` (non-TTY) still produces the minimal tree.

## Known limitations / deferred

- No runtime boot test of scaffolded pokedex (dual-React `file:` limitation —
  same as the existing minimal scaffold test).
- Picker is a numbered prompt, not an arrow-key TUI.
- Tarball size grows by the pokedex source (≈ app.css 60 KB + a handful of small
  TS files; FRAMEWORK-GAPS.md 25 KB excluded). Acceptable for a template.

## Open questions resolved at plan time

- **Prompt mechanism:** Bun global `prompt()`. Wrap in `selectTemplate` with an
  injected reader for testability.
- **`-t` short flag:** include it (cheap, conventional).
- **pokedex deps:** brustjs/react/react-dom/zod; no tailwind (verified from source).
