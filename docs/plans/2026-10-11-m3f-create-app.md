# m3f-create-app: `@brust/create-app` (bin `create-app`) so `bun create @brust/app <name> [--template blank|pokedex]` works; blank + pokedex templates, scaffold tests from packed tarballs, release refs, docs

**RULED by lead Detoro 2026-10-11 (before dispatch): R1-R10 ALL ACCEPTED as their defaults (spec E8 amended on v2/m3f). Side finding 'dist/native empty in tarball installs' (build/index.ts:157-158) is NOT this lane's: the lead files it as ledger F85 and decides before beta. Dispatch only AFTER m3f-pokedex-team merges (the template is a copy of the finished example); Task 1 (merge origin/m3f + re-verify anchors) mandatory. First publish of @brust/create-app = human tag push.**

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: m3f after wave-2 lanes merge · lane: m3f-create-app · tier: standard · review: standard

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land spec `docs/design/2026-10-11-m3f-actions-elysia-create-app-design.md` §2.4 (E8, A6) and §4 acceptance items 2–4 on `lane/m3f-create-app`. After this lane:
- **Package.** `packages/create-app` is a new workspace package `@brust/create-app` with one bin, `create-app`. It has no runtime dependencies. It ports the 0.1.x `brust new` semantics:
  - the name rule `^[a-z0-9][a-z0-9_-]*$`, at most 50 characters;
  - a non-empty target directory is refused;
  - a TTY picker with `blank` as the default;
  - the placeholders `__PROJECT_NAME__` and `__BRUST_DEP__` (a JSON-encoded spec);
  - `*.tmpl` files lose the suffix and `_gitignore` becomes `.gitignore`;
  - the next steps are printed at the end.
- **Templates.**
  - `templates/blank` is committed. It has one page, one native counter (`useState`, lowered to a signal), an Elysia `actions.ts` with a hello endpoint on `brust()`, a `brust.toml` with `[server]` and `[actions]`, a tsconfig, a README and `package.json.tmpl`.
  - `templates/pokedex` is GENERATED from `examples/pokedex` by `scripts/sync-template.ts`. It runs at `prepack`, in monorepo runs and in tests, and the output is gitignored.
- **Dependency spec.**
  - Published: `^<own version>`.
  - In the monorepo: `workspace:*` when the target is inside a workspace glob; otherwise `file:<repo>/packages/brust` plus an `overrides` block.
  - `--brust-dep <spec>` sets the spec explicitly (for CI).
- **Tests.**
  - Unit tests.
  - A pack test that lists the tarball.
  - `test/scaffold.test.ts`, which is slow. It runs `bun create @brust/app` through the packed `@brust/create-app`. Core and runtime-dom come from packed tarballs. Then `bun install`, `bun run build`, `bun run start` on a free port, and HTTP probes.
  - Both new suites are in `ci.yml`.
- **Release and docs.**
  - `scripts/release-bump.ts` covers the new package. `release.yml` dry-runs and publishes it (R7).
  - `docs/create-app.md` (one page).
  - The README has a quick start.

**Reading order:**
1. The spec: §0 "Scaffold", E8, E9, §2.4, A6, §4 items 2–4 (`docs/design/2026-10-11-m3f-actions-elysia-create-app-design.md:24,64-66,77,79-83`).
2. The handoff lines of the wave-2 plans:
   - `docs/plans/2026-10-11-m3f-pokedex-team.md:649`: the template excludes `data/team.sqlite*`; `examples/pokedex/.gitignore` → `_gitignore`; exact elysia/eden deps; `POKEDEX_TEAM_DB`.
   - `docs/plans/2026-10-11-m3f-actions-elysia.md:650`: Elysia 2 order `(path, hook, handler)`; `[actions]` is opt-in.
3. 0.1.x, read-only, at `~/code/brust` (main):
   - `runtime/cli/new.ts` (all 294 lines; `:12-69` parseArgs, `:90-98` resolveBrustRef, `:100-163` copyTemplate, `:165-220` selectTemplate/promptPicker, `:221-294` runNew/printNextSteps);
   - `runtime/cli/templates.ts:62-138`;
   - `create-brustjs/{index.ts,package.json}`;
   - `tests/cli-new.test.ts` (464 lines; test names at `:17-437`);
   - `runtime/cli/templates/minimal/*`.
4. v2 (line numbers at m3f @d910403; re-anchor in Task 1):
   - `package.json:5-14` (workspaces include `packages/*`);
   - `packages/brust/package.json:9-65` (bin `brust`, `files`, `workspace:*` deps `:44-46`, optional natives);
   - `packages/runtime-dom/package.json`;
   - `examples/pokedex/{package.json,brust.toml,routes.tsx,README.md,test/build.test.ts:7}`;
   - `Makefile:41-61`;
   - `scripts/release-bump.ts:14-37`;
   - `.github/workflows/ci.yml:115-140`, `release.yml:66-69,101-116`;
   - `tests/server/harness.ts:6-31` (the free-port start pattern).

## Facts (m3f @d910403; probes 2026-10-11, Bun 1.4.3 / pack reports 1.4.3-canary.1+e555359cc, macOS arm64; scratch `/private/tmp/claude-501/-Users-detoro-code-brust/a8280810-2b60-4e66-a1d6-2739300c5cfe/scratchpad/create-probe/`)

**`bun create` → bin (probed with a local `@brust/create-app`; `bunx` resolves `node_modules/.bin` first).**
- `bun create @brust/app myapp --template pokedex --yes --dir x` runs the package bin with argv `["myapp","--template","pokedex","--yes","--dir","x"]`. Long flags pass verbatim and in order. So do `--template=blank`, `--force`, `--no-install`, `--no-git`, `--help`, `-h`, `--open`, `--verbose` and `--brust-dep file:/x`.
- **Bun rejects the short flags `-t` and `-y` itself.** It prints `error: Invalid Argument '-t'` / `'-y'` and exits before our bin runs, whatever their position (also `bun create -y @brust/app`). `bun create @brust/app myapp -- -t blank -y` passes a literal `"--"` through: `["myapp","--","-t","blank","-y"]`. `bunx @brust/create-app myapp -t blank -y` passes short flags fine. See R1.
- `bun create @brust/app` with no further args → argv `[]`.
- The bin runs with `process.cwd()` = the caller's directory. `import.meta.dir` = the installed package (`…/node_modules/@brust/create-app/…`).
- **Bin naming.**
  - With ONE bin, any bin name works: a bin named `brust-create` ran.
  - With two bins, the one named `create-app` wins: `{aaa, create-app}` ran `create-app`; `{aaa, zzz}` ran `aaa`.
  - Naming it `create-app` (E8) is therefore the robust choice.
- `bun create ./local-path dest` is treated as a GitHub repo (`error: "./.." was not found on GitHub`). Local templates exist only as `~/.bun-create/<name>`. Tests therefore install `@brust/create-app` from its tarball into a host dir and run `bun create` there.
- `npm view @brust/create-app` → 404; `npm view @brust/core` → 404. Nothing is published yet, so a `^<version>` spec cannot resolve in tests. They use `--brust-dep file:<tarball>`.

**Installing `@brust/core` outside the workspace.**
- `"@brust/core": "file:<repo>/packages/brust"` alone fails: `error: Workspace dependency "@brust/runtime-dom" not found` / `@brust/runtime-dom@workspace:* failed to resolve`. The cause is `packages/brust/package.json:44-46` and the six `workspace:*` optional natives. A spec of `workspace:*` or bare `file:` (spec E8) therefore does not work for a target outside the workspace globs.
- `file:<repo>/packages/brust` plus `"overrides": { "@brust/runtime-dom": "file:<repo>/packages/runtime-dom", "@brust/native-<plat>": "file:<repo>/npm/<plat>" ×6 }` installs. This is the hoisted layout: 85 packages, because devDependencies of a `file:` folder dep are installed too.
  - The whole folder is copied, including `native/brust.darwin-arm64.node`.
  - `import('@brust/core/store')` works.
  - `brust build routes.tsx` → `built dist in 28ms`. The counter is `"tier": "native"` and the page is `"static"`.
  - `brust start --port 41731 --workers 1` serves `<button x-data="counter_4a7ef039" … x-on-click="_h1">count is <span x-text="_c1">0</span></button>` plus the runtime and chunk `<script type="module">` tags.
  - `bun check` → `No type errors in 5 files`.
- **Tarballs** (`bun pm pack --destination <d>` in `packages/brust` and `packages/runtime-dom`) → `brust-core-0.0.0.tgz` (43.9 KB) and `brust-runtime-dom-0.0.0.tgz`.
  - The packed core has `"@brust/runtime-dom": "0.0.0"` (workspace rewritten) and NO `.node` (`files` = `native/index.js`, `native/index.d.ts`).
  - Install with `@brust/core: file:<core.tgz>` + overrides `@brust/runtime-dom: file:<rd.tgz>`, `@brust/native-darwin-arm64: file:<dir>`, where `<dir>` is a copy of `npm/darwin-arm64/{package.json,README.md}` + `packages/brust/native/brust.darwin-arm64.node`. Result: `6 packages installed`. The other five optional natives are skipped silently.
  - `bun run build` → ok; `bun run start --port 0 --workers 1` → `[brust] listening on 127.0.0.1:54494`, `[brust] ready (1 worker)`, and the page renders.
  - Observed, not this lane's to fix: `dist/native/` is EMPTY in a tarball install. `build/index.ts:157-158` copies only `.node` files sitting next to core, and the addon comes from the `@brust/native-<plat>` package instead. `bun dist/index.js` still resolves the addon through `@brust/core`. This is a note for the lead (F-ledger candidate).
- `bun run start --port 0 --workers 1` forwards the args: `$ brust start --port "0" --workers "1"`. The listen line is printed by `crates/brust-server/src/server/mod.rs:224` (`[brust] listening on {local} …`) and readiness by `packages/brust/src/run.ts:129` (`[brust] ready (N worker…)`). `tests/server/harness.ts:9-19` already parses both and clears `BRUST_PORT/BRUST_WORKERS/BRUST_ADDR`.

**Packing `@brust/create-app`** (scratch package with `files: ["bin","src","templates"]`):
- `prepack` runs on `bun pm pack` AND on `bun publish --dry-run`: `$ echo PREPACK-RAN2 > …`, and the file it wrote is packed. So `scripts/sync-template.ts` at `prepack` covers both.
- A path listed in `files` is packed even when the package's own `.gitignore` lists it (`templates/pokedex/` was gitignored and still packed).
- Packed: `templates/blank/_gitignore`, `package.json.tmpl`, `.env.example`. **Also packed: `templates/blank/node_modules/**` and `templates/blank/dist/**`.** The `files` whitelist does not filter them, so the sync must never write them.
- **Silently dropped:** nested `.gitignore` and `.npmrc` (`templates/blank/sub/.gitignore`, `sub/.npmrc`). This is why the template uses `_gitignore`.
- Bin files are packed `0755` even when the source is `0644`. A tarball install then runs through `bun create` with argv intact.

**v2 app conventions to match.**
- `examples/pokedex/package.json:6-12` scripts: `build: brust build routes.tsx`, `start: brust start`, `snapshot`, `test: bun test`, `typecheck: bun check`. There is NO `dev` script and no `brust dev` (F61, `Makefile:1-8`). `make dev` = `build` then `start` (`Makefile:41-61`). Deps: `@brust/core: workspace:*`, `react`/`react-dom` `^19.2.0`; devDeps `@types/bun ^1.4.0`, `@types/react ^19.2.0`, `typescript ^7.0.2`.
- `examples/pokedex/brust.toml` = `[server] address = "127.0.0.1"`, `port = 1337`. The pokedex-team lane adds `[build] server_only` and `[actions]` (`pokedex-team.md:167`).
- The document root is a layout component rendering `<html>`, `<head>` and `<body>` with `<Outlet/>` (`packages/brust/test/fixtures/app/AppLayout.tsx:1-20`, `examples/pokedex/components/AppLayout.tsx:9-31`). Static files are served at `/public/…`.
- `examples/pokedex/test/build.test.ts:7` hard-codes `join(app, '../../packages/brust/bin/brust')`, so it cannot run in a scaffolded app. `test/snapshot.test.ts` is dataset dogfood. The pokedex-team lane adds `test/{team-db,actions}.test.ts`.
- There is no `examples/pokedex/.gitignore` today. The pokedex-team lane adds one with `data/team.sqlite*` (`pokedex-team.md:54,252`). The DB path is `POKEDEX_TEAM_DB`, else `<cwd>/data/team.sqlite`, opened lazily (`:108,249`). `POST /team` body is `{ id: t.Integer }` (spec E7 as amended), and it returns `{ team, max }`.
- Elysia pins (spec A5, elysia R7): `elysia 2.0.0-beta.30` and `@elysia/eden 2.0.0-beta.6` are exact optional peers of `@brust/core`. The APP must install both (`pokedex-team.md:33`). `[actions]` is opt-in. An empty table means `entry = "actions.ts"`, `prefix = "/_brust/action"` and `max_body_bytes = 262144` (`actions-elysia.md:120,380`). Elysia 2 route order is `(path, hook, handler)`; the 1.x order throws at definition time (`actions-elysia.md:52`).
- `scripts/release-bump.ts:14-15` lists 8 refs (`FILES`, `EXPECTED = FILES.length`). `:35` checks that nothing is `private`. `--release` stages `FILES` (`:41`).
- `release.yml` has three relevant parts:
  - `:66` dry-run loop `for d in packages/runtime-dom packages/brust npm/*`;
  - `:101-103` tarball checks;
  - `:113-116` publish order `runtime-dom → natives → core`, then `dist-tag add … latest` for prereleases (memory: npm-latest-dist-tag-policy).
- `ci.yml` runs on `pull_request` → v2 only (`:6-10`). The server job builds the addon at `:117` (`bun run build:debug`) and then runs the pokedex lines `:128-129`.
- The 0.1.x scaffold test deferred end-to-end boot because a `file:` install gave dual React (`tests/cli-new.test.ts:163-168`). v2 tarball installs carry no React copy of their own (core lists React as a peer and ships no devDeps), but in the probe the hoisted `file:` install did put core's devDependency React at the top level. The pokedex island (react tier) therefore guards this in the scaffold test (risk 2).

## Rulings requested from the lead before dispatch

Each one has a default that the implementer follows unless the lead answers differently.
- **R1: short flags.** Bun rejects `-t` and `-y` before our bin runs. Default:
  - keep the `-t`/`-y` aliases for `bunx @brust/create-app` (0.1.x parity, `new.ts:36,42`);
  - document ONLY the long forms for `bun create`;
  - skip a bare `--` token in `parseArgs`;
  - `--help`/`-h` print the usage and exit 0.
- **R2: monorepo dependency mode** (spec E8 says "`workspace:*`/`file:`"; the Facts show bare `file:` fails). Default for `resolveBrustDep`:
  1. `--brust-dep <spec>` → verbatim, with no overrides.
  2. Monorepo (see R3 detection), target inside a root workspace glob (e.g. `examples/<x>`) → `workspace:*`.
  3. Monorepo, any other target → `file:<repo>/packages/brust` plus an `overrides` block for `@brust/runtime-dom` and the six `@brust/native-*`, merged into the emitted `package.json` after substitution. A6 placeholders stay exactly two.
  4. Otherwise → `^<create-app's own version>`.
- **R3: published version source and monorepo detection.**
  - `@brust/create-app` has NO dependency on `@brust/core`. `bunx` therefore never downloads the native addon just to scaffold. This is unlike 0.1.x `create-brustjs`, which depended on `brustjs`.
  - `__BRUST_DEP__` = `^` + `packages/create-app/package.json` `version`. `release-bump.ts` keeps it equal to core.
  - Monorepo = `resolve(pkgRoot,'../..')/package.json` has `name === 'brust-v2'` and an array `workspaces`, AND `packages/brust/package.json` has `name === '@brust/core'`, AND `examples/pokedex/routes.tsx` exists. There is no walking up, so a bunx cache can never match.
- **R4: pokedex template contents** (spec E8 lists only `test/snapshot*`). Default: copy `examples/pokedex` EXCEPT
  - the top-level `dist`, `dist-*`, `test/`, `README.md`, `package.json`, `.gitignore`;
  - `node_modules` and `.DS_Store` at any depth;
  - `data/team.sqlite*` and `*.tsbuildinfo`.
  - `test/` goes entirely because `build.test.ts:7` is monorepo-bound; the generated `package.json.tmpl` drops the `test` script.
  - `README.md.tmpl` comes from the committed overlay `template-overlays/pokedex/`.
  - `_gitignore` = `node_modules/`, `dist/` plus the lines of `examples/pokedex/.gitignore`.
- **R5: generated, not committed.** `templates/pokedex/` is gitignored (package-local `.gitignore`). It is produced:
  - by `prepack` (covers `bun pm pack` and `bun publish`, Facts);
  - by `create-app` itself in monorepo mode before copying (never stale for a developer);
  - by the tests.

  The alternative is to commit it and gate it with `git diff --exit-code` like the battery reports. That duplicates the 152 KB dataset and every pokedex edit.
- **R6: scripts.** Both templates have `build: brust build routes.tsx`, `start: brust start`, `typecheck: bun check`, and `dev: brust build routes.tsx && brust start` (`make dev` semantics, F61). `printNextSteps` keeps `bun run dev` (spec E8). The pokedex `package.json.tmpl` is DERIVED from `examples/pokedex/package.json`: name → `__PROJECT_NAME__`, version `0.0.1`, `@brust/core` → `__BRUST_DEP__`, `test` dropped, `dev` added unless present; the other fields are verbatim.
- **R7: `release.yml` is in this lane's boundary.**
  - The dry-run loop gains `packages/create-app`.
  - A tarball check for create-app: templates present, no `node_modules/`, `dist/`, `team.sqlite` or `test/`.
  - Publish: `pub packages/create-app @brust/create-app` AFTER core, and `@brust/create-app` in the prerelease `dist-tag` loop.
  - Publishing remains the human tag push. Without this edit, `bun create @brust/app` can never resolve.
- **R8: what the scaffold test installs.**
  - `@brust/create-app`, `@brust/core` and `@brust/runtime-dom` come from `bun pm pack` tarballs (the published shape; lesson: published-install-tarball-test).
  - The host native is a `file:` dir: `npm/<plat>/package.json` + the built `packages/brust/native/brust.<plat>.node`.
  - The test injects `overrides` into the scaffolded `package.json`.
  - One extra test covers monorepo mode (R2.3) for blank, up to `bun run build`.
- **R9: blank UI.** Default: the counter only. The hello action is shown in the README (curl + a `client<App>()` snippet) and probed by the test. No UI calls it, so blank does not depend on async-handler support in native components. Alternative: a `Hello` native button mirroring the pokedex `AddToTeamButton` pattern.
- **R10: probes are HTTP-only.**
  - "The counter works" (§4.3) = native-tier markup (`x-data="counter_…"`, `x-on-click`) plus its chunk answering 200. Click behaviour is covered by `browser-test` and `hydrate.chromium`.
  - "The island shows it" (§4.2) = the SSR'd TeamBuilder carries the new member after the POST.
  - The lead may do one manual Chromium click at READY.

## Global constraints

**Lane:**
```
cd ~/code/brust-m3f && git pull --ff-only && git worktree add ../brust-lane-m3f-create-app -b lane/m3f-create-app m3f
cd ../brust-lane-m3f-create-app && bun install --frozen-lockfile && (cd packages/brust && bun run build:debug)
```
Do NOT use `conclave lane start`, which branches from `main`. Line numbers are at m3f @d910403, before the actions-bridge, actions-elysia and pokedex-team merges. Task 1 re-anchors them. If code moved, re-anchor on the quoted text and say so in the task note.

**TDD.** Every task writes its failing tests first, runs them, and pastes the red line into the task note before any implementation.

**Typecheck.** `cd packages/create-app && bun run typecheck` (= `bun check`) prints `No type errors`. The package tsconfig EXCLUDES `templates` and `template-overlays`, because their sources import `@brust/core` and `elysia`, which this package does not depend on. Templates are typechecked inside the scaffolded app (Task 9). There is no root biome gate.

**Commits.** Never `git add -A`; stage by name. Before each commit, `git status --short` lists exactly the task's files, and never `packages/create-app/templates/pokedex/**` (gitignored). Every message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. NO PR: post READY on the Conclave task, and the lead merges into `m3f`.

**Never touch `examples/pokedex/**`.** It is the template's source of truth. A defect found there (for example a monorepo-relative path outside `test/`) is a `task challenge` to the lead with the failing probe, never a patch here. `ls examples/pokedex/data` = what it was at Task 1 after every gate. No test may write into `examples/pokedex`.

**Do not re-decide:**
- the A6 placeholders (exactly `__PROJECT_NAME__` and `__BRUST_DEP__`);
- the `.tmpl`/`_gitignore` rules;
- the name regex and the 50-character limit;
- the default template `blank`;
- the package name `@brust/create-app` and the bin `create-app`;
- the Elysia pins;
- `[actions]` opt-in semantics.

## Boundary (exact)

- NEW `packages/create-app/{package.json,tsconfig.json,.gitignore,README.md}`.
- NEW `packages/create-app/bin/create-app.ts`; `src/{args,dep,copy,templates,cli}.ts`; `scripts/sync-template.ts`.
- NEW `packages/create-app/templates/blank/**`, `template-overlays/pokedex/README.md.tmpl`.
- NEW `packages/create-app/test/{args,copy,dep,templates,cli,sync-template,pack,scaffold}.test.ts`, `test/helpers.ts`.
- `bun.lock`: only the lines `bun install` writes for the new workspace.
- `scripts/release-bump.ts`; `.github/workflows/ci.yml` (two lines); `.github/workflows/release.yml` (R7 lines only).
- `README.md` (a quick-start section); NEW `docs/create-app.md`.

NOT touched:
- `examples/**`, `packages/brust/**`, `packages/runtime-dom/**`, `crates/**`, `npm/**`, `tests/**`;
- the root `package.json`: `packages/*` already matches;
- the root `.gitignore`: the generated dir is ignored by `packages/create-app/.gitignore`.

## Tasks

### Task 1: Merge origin/m3f, re-verify anchors, baseline (mandatory first)

- [ ] **Step 1:** `git fetch origin && git merge --no-edit origin/m3f`. Confirm that all three wave-2 lanes are in: `git log --oneline origin/m3f | grep -E 'actions-bridge|actions-elysia|pokedex-team'`. If any is missing, STOP and tell the lead.
- [ ] **Step 2: Re-verify each anchor** and paste the output:
  ```
  grep -n '"./elysia"\|"./client"\|"elysia"\|"@elysia/eden"' packages/brust/package.json
  cat examples/pokedex/package.json examples/pokedex/brust.toml examples/pokedex/.gitignore
  ls examples/pokedex examples/pokedex/test examples/pokedex/data docs/actions.md
  grep -n "post('/team'\|t.Integer\|export type App\|adapter: brust()" examples/pokedex/actions.ts
  grep -rn "POKEDEX_TEAM_DB" examples/pokedex/lib | head -3
  grep -rn '\.\./\.\./' examples/pokedex --include='*.ts' --include='*.tsx' --include='*.json' --include='*.toml' | grep -v node_modules
  grep -n "team" tests/server/pokedex.test.ts | head -20     # the SSR marker of a team member (used in Task 9)
  grep -n "FILES =\|EXPECTED" scripts/release-bump.ts; grep -n "for d in packages\|pub packages\|dist-tag add" .github/workflows/release.yml
  grep -n "build:debug\|cd examples/pokedex" .github/workflows/ci.yml
  ```
  Record in the note:
  - the final pokedex `scripts` and `dependencies`;
  - the `[actions]` table;
  - every `../../` hit outside `test/`. Any such hit breaks the template: file a challenge (constraint).
  - the exact HTML marker that `tests/server/pokedex.test.ts` uses for a member in TeamBuilder.
- [ ] **Step 3: Baseline**, pasted:
  - `cd examples/pokedex && bun test && bun run typecheck`;
  - `cd packages/brust && bun test --timeout 120000 test/e2e-actions.test.ts`;
  - `bun install --frozen-lockfile` → no change.

### Task 2: Package skeleton + `src/args.ts`

**Files:** NEW `packages/create-app/{package.json,tsconfig.json,.gitignore,README.md}`, `bin/create-app.ts`, `src/args.ts`, `test/args.test.ts`; `bun.lock`.

- [ ] **Step 1: Skeleton.**
  ```json
  {
    "name": "@brust/create-app",
    "version": "0.0.0",
    "description": "Scaffold a brust v2 app — bun create @brust/app <name>",
    "license": "MIT",
    "repository": { "type": "git", "url": "git+https://github.com/AssetsArt/brust.git", "directory": "packages/create-app" },
    "type": "module",
    "bin": { "create-app": "./bin/create-app.ts" },
    "files": ["bin", "src", "templates", "README.md"],
    "scripts": {
      "build": "bun scripts/sync-template.ts",
      "prepack": "bun scripts/sync-template.ts",
      "test": "bun test",
      "typecheck": "bun check"
    },
    "devDependencies": { "@types/bun": "^1.4.0", "typescript": "^7.0.2" },
    "publishConfig": { "access": "public" }
  }
  ```
  - The version equals `packages/brust/package.json` `version` (Task 10 enforces it).
  - `tsconfig.json`: the `packages/brust/tsconfig.json` options, with `"include": ["src","test","bin","scripts"]` and `"exclude": ["templates","template-overlays","**/dist"]`.
  - `.gitignore`: `templates/pokedex/`.
  - `bin/create-app.ts`:
    ```ts
    #!/usr/bin/env bun
    // `bun create @brust/app <name> …` runs this bin (bunx @brust/create-app) with the remaining argv.
    import { main } from '../src/cli.ts'
    await main(process.argv.slice(2))
    ```
  - Run `bun install` at the lane root. `git diff bun.lock` touches only the new workspace block. Then `bun install --frozen-lockfile` → clean.
- [ ] **Step 2: Failing tests** `test/args.test.ts`. Port these by name from 0.1.x `tests/cli-new.test.ts:17-70,290-312`, with the message prefix `create-app:` instead of `brust new:`:
  `parseArgs: positional name → targetDir = cwd/<name>` · `--dir overrides target` · `--dir=value form` · `relative --dir resolved against cwd` · `missing name throws` (`missing project name`) · `unknown flag throws` · `--dir without value throws` · `invalid project name throws (uppercase | starts with hyphen | space)` · `digit-start name is valid` · `name too long throws` (51 chars) · `--template pokedex` · `--template=pokedex` · `-t blank` · `--template without value throws` · `--template= (empty) throws` · `--yes / -y set yes` · `yes defaults false, template undefined`.
  New: `--brust-dep <spec> and --brust-dep=<spec> set brustDep; empty throws` · `a bare -- is ignored (bun create passes it through)` · `--help / -h set help and skip name validation`.
- [ ] **Step 3: Implementation.** Port `new.ts:12-69` verbatim with these changes:
  - `ParsedArgs` gains `brustDep?: string` and `help: boolean`;
  - `--` → `continue`;
  - the message prefix is `create-app:`;
  - the usage line is `usage: bun create @brust/app <name> [--template blank|pokedex] [--dir <path>] [--yes] [--brust-dep <spec>]`.
- [ ] **Step 4:** `bun test test/args.test.ts` → all pass; typecheck. Commit `feat(create-app): package skeleton and argument parsing (0.1.x brust new parity; M3-F E8)`.

### Task 3: `src/copy.ts`: copyTemplate, `.tmpl`, `_gitignore`

**Files:** NEW `src/copy.ts`, `test/copy.test.ts`.

- [ ] **Step 1: Failing tests.** Port from `tests/cli-new.test.ts:83-138,352-390`:
  `copyTemplate: strips .tmpl suffix and substitutes` · `recurses into subdirectories` · `throws if templateDir missing` (`template directory not found`).
  New: `_gitignore → .gitignore; a nested _gitignore too` · `non-.tmpl files are copied byte-for-byte (a binary file round-trips) and never substituted` · `__BRUST_DEP__ substitution yields valid JSON: package.json.tmpl with "@brust/core": __BRUST_DEP__ parses after JSON.stringify("file:/a b\"c")`.
- [ ] **Step 2: Implementation.** Port `new.ts:100-163` (`copyTemplate`, `copyDir`, `renameForEmit`, `applySubstitutions`) and drop `exclude`/`extraFiles`: R4/R5 moved them into the sync. Keep `ent.isFile()` only (symlinks are skipped, as in 0.1.x).
- [ ] **Step 3:** Pass; typecheck. Commit `feat(create-app): copyTemplate — .tmpl substitution and _gitignore rename (A6)`.

### Task 4: `src/dep.ts`: `__BRUST_DEP__` resolution (R2, R3)

**Files:** NEW `src/dep.ts`, `test/dep.test.ts`.

- [ ] **Step 1: Failing tests.** Fake monorepos are built in `mkdtemp`: a root `package.json` `{name:'brust-v2', workspaces:['packages/*','examples/*']}`, `packages/brust/package.json` `{name:'@brust/core'}`, `examples/pokedex/routes.tsx`, and `packages/create-app/package.json` `{version:'1.2.3-alpha.4'}`.
  1. `explicit --brust-dep wins verbatim, no overrides`
  2. `published (no monorepo markers) → ^<own version>`: pkgRoot is a temp `node_modules/@brust/create-app`.
  3. `monorepo + target under a workspace glob (examples/demo) → workspace:*`
  4. `monorepo + target outside → file:<root>/packages/brust + overrides for runtime-dom and the six natives`. The key set is exact and the paths are absolute.
  5. `a root package.json with another name is not a monorepo`
  6. `the real repo is detected from packages/create-app` (`monorepoRoot()` === the lane root).
  7. `applyOverrides merges into package.json and keeps 2-space JSON + trailing newline`
- [ ] **Step 2: Implementation:**
  ```ts
  export const PLATS = ['darwin-x64','darwin-arm64','linux-x64-gnu','linux-arm64-gnu','linux-x64-musl','linux-arm64-musl'] as const  // = release-bump.ts:13
  export interface BrustDep { kind: 'explicit' | 'version' | 'workspace' | 'file'; spec: string; overrides?: Record<string, string> }
  export const packageRoot = (): string => resolve(import.meta.dir, '..')
  export function monorepoRoot(pkgRoot = packageRoot()): string | null { /* R3: exact ../.. markers, no walking */ }
  export function resolveBrustDep(o: { explicit?: string; targetDir: string; pkgRoot?: string }): BrustDep { /* R2 order 1-4 */ }
  function inWorkspace(root: string, target: string): boolean   // 'x/*' → dirname(target) === join(root,'x'); 'x' → target === join(root,'x')
  export function applyOverrides(appDir: string, overrides: Record<string, string>): void
  ```
- [ ] **Step 3:** Pass; typecheck. Commit `feat(create-app): resolve the @brust/core spec — published ^version, workspace:*, file: + overrides, --brust-dep (R2/R3)`.

### Task 5: `src/templates.ts`: registry, selectTemplate, TTY picker

**Files:** NEW `src/templates.ts`, `test/templates.test.ts` (selection half; the pins half comes in Task 7).

- [ ] **Step 1: Failing tests.** Port from `tests/cli-new.test.ts:227-243,316-350`, with `minimal` → `blank`:
  `listTemplates returns blank + pokedex` · `DEFAULT_TEMPLATE resolves to a registered template (blank)` · `selectTemplate: explicit valid name` · `explicit invalid name throws` (`unknown template "x" — choose one of: blank, pokedex`) · `yes → default blank` · `non-TTY → default blank` · `TTY + read "2" → pokedex` · `TTY + read "" → default blank` · `TTY + read name "pokedex" → pokedex` · `TTY + null reader → default blank (no infinite loop)`. New: `TTY + three invalid answers → default blank`.
- [ ] **Step 2: Implementation.** `TemplateDef = { name, description, dir, generated }`:
  - `blank`: `templates/blank`, `generated: false`, "One page, a native counter, an Elysia hello action".
  - `pokedex`: `templates/pokedex`, `generated: true`, "The v2 Pokédex: loaders, L1 cache, native + island, the team store on Elysia actions + SQLite".

  `selectTemplate`/`promptPicker` are ported verbatim from `new.ts:165-220` (Bun's global `prompt()`).
- [ ] **Step 3:** Pass; typecheck. Commit `feat(create-app): template registry and TTY picker (default blank)`.

### Task 6: `src/cli.ts`: `main` (runNew port) + next steps

**Files:** NEW `src/cli.ts`, `test/cli.test.ts`.

- [ ] **Step 1: Failing tests.** They spawn `bun bin/create-app.ts` with `stdin: 'ignore'` and use `--brust-dep file:/x` unless the test says otherwise. Port from `tests/cli-new.test.ts:140-169`:
  `missing name → exit 1` · `invalid name → exit 1` · `non-empty target dir → exit 1` (`not empty`). New:
  - `--help → usage on stdout, exit 0`
  - `blank scaffold emits the tree with no .tmpl, no _gitignore, no placeholder leaks; package.json name + "@brust/core": "file:/x"`
  - `an empty existing target dir is accepted`
  - `a failed copy removes a target it created (rollback)`: point the template dir at a missing path through an env hook `CREATE_APP_TEMPLATES_DIR` (test-only, documented in `src/templates.ts`).
  - `next steps print cd ./<rel>, bun install, bun run dev`
  - `monorepo mode without --brust-dep re-syncs pokedex then writes file: + overrides` (asserts `templates/pokedex/routes.tsx` exists afterwards and that `package.json` has `overrides['@brust/runtime-dom']`). This test depends on Task 8's `syncTemplate`: write it here as `test.todo` and turn it on in Task 8.
- [ ] **Step 2: Implementation.** Port `new.ts:221-294`:
  ```ts
  export async function main(argv: string[]): Promise<void> {
    // parseArgs (help → usage, exit 0) → non-empty dir check (new.ts:233-240)
    // → selectTemplate({ explicit, yes, isTTY: Boolean(process.stdin.isTTY) })
    // → dep = resolveBrustDep({ explicit: brustDep, targetDir })
    // → if (tmpl.generated && monorepoRoot()) syncTemplate()            // R5 (Task 8)
    // → copyTemplate({ templateDir: tmpl.dir, targetDir, substitutions: { __PROJECT_NAME__: name, __BRUST_DEP__: JSON.stringify(dep.spec) } })
    // → if (dep.overrides) applyOverrides(targetDir, dep.overrides)
    // → on any throw: rm the target if it did not exist before (new.ts:273-279), exit 1
    // → printNextSteps (new.ts:284-294) + when dep.kind === 'workspace': "run `bun install` at the repo root"
  }
  ```
- [ ] **Step 3:** Pass (except the `todo`); typecheck. Commit `feat(create-app): create-app main — runNew port with rollback and next steps`.

### Task 7: The `blank` template

**Files:** NEW `templates/blank/{package.json.tmpl,README.md.tmpl,_gitignore,brust.toml,tsconfig.json,routes.tsx,actions.ts,components/Layout.tsx,components/Counter.tsx,pages/HomePage.tsx,public/app.css,public/favicon.svg}`; `test/templates.test.ts` (pins half).

- [ ] **Step 1: Failing tests** (`test/templates.test.ts`):
  - `blank has the E8 file set`.
  - `blank pins equal the repo`:
    - `elysia` and `@elysia/eden` equal `packages/brust/package.json` `peerDependencies` (exact);
    - `react`, `react-dom`, `@types/bun`, `@types/react` and `typescript` equal `examples/pokedex/package.json`.
    - Parse `package.json.tmpl` after substituting `__BRUST_DEP__` → `"x"`.
  - `blank scripts are dev/build/start/typecheck per R6`.
  - `blank brust.toml has [server] and an [actions] table`: `Bun.TOML.parse`; `actions` is `{}`.
  - `blank actions.ts uses brust() and the Elysia 2 (path, hook, handler) order`: source contains `adapter: brust()` and `export type App`.
- [ ] **Step 2: Files.** Each mirrors a probed v2 shape (Facts):
  - `package.json.tmpl`:
    ```json
    {
      "name": "__PROJECT_NAME__",
      "version": "0.0.1",
      "private": true,
      "type": "module",
      "scripts": {
        "dev": "brust build routes.tsx && brust start",
        "build": "brust build routes.tsx",
        "start": "brust start",
        "typecheck": "bun check"
      },
      "dependencies": {
        "@brust/core": __BRUST_DEP__,
        "@elysia/eden": "2.0.0-beta.6",
        "elysia": "2.0.0-beta.30",
        "react": "^19.2.0",
        "react-dom": "^19.2.0"
      },
      "devDependencies": { "@types/bun": "^1.4.0", "@types/react": "^19.2.0", "typescript": "^7.0.2" }
    }
    ```
  - `brust.toml`:
    ```toml
    [server]
    address = "127.0.0.1"
    port = 1337

    # Elysia actions (docs/actions.md). Defaults: entry = "actions.ts", prefix = "/_brust/action", max_body_bytes = 262144
    [actions]
    ```
  - `actions.ts`:
    ```ts
    import { brust } from '@brust/core/elysia'
    import { Elysia, t } from 'elysia'

    // One Elysia 2 app, served by the Rust server under /_brust/action (brust.toml [actions]).
    // Elysia 2 takes (path, hook, handler). Never call app.listen(): Rust owns HTTP.
    const app = new Elysia({ adapter: brust() }).get(
      '/hello',
      { query: t.Object({ name: t.Optional(t.String()) }) },
      ({ query }) => ({ message: `Hello, ${query.name ?? 'world'}!` }),
    )

    export default app
    export type App = typeof app
    ```
    Re-check it against a `docs/actions.md` block after Task 1. If the merged API differs, follow the docs and say so in the note.
  - `routes.tsx`: `defineRoutes([{ Component: Layout, children: [{ path: '/', Component: HomePage }] }])` (the probe app).
  - `components/Layout.tsx`: `<html lang="en">`, `<head>` with `<meta charSet="utf-8"/>`, viewport, `<title>__</title>`, `/public/favicon.svg` and `/public/app.css`, then `<body><Outlet/></body>`.
  - `components/Counter.tsx`: `useState(0)` + `<button type="button" onClick={() => setCount(count + 1)}>count is {count}</button>`. The probe built it as `tier: native`.
  - `pages/HomePage.tsx`: a heading, one sentence and `<Counter />`.
  - `public/app.css`: under 40 lines of plain CSS, no Tailwind. `public/favicon.svg` is a copy of the pokedex one.
  - `tsconfig.json`: a byte copy of `examples/pokedex/tsconfig.json`.
  - `_gitignore`: `node_modules/` and `dist/`.
  - `README.md.tmpl`: `# __PROJECT_NAME__`, run (`bun install`, `bun run dev` → http://127.0.0.1:1337), the layout, the action (`curl 'http://127.0.0.1:1337/_brust/action/hello?name=ash'`), a client snippet (`import { client } from '@brust/core/client'; import type { App } from './actions'; const api = client<App>(); const { data } = await api.hello.get({ query: { name: 'ash' } })`), and links to docs.
- [ ] **Step 3:** `bun test test/templates.test.ts` → pass. Commit `feat(create-app): blank template — native counter, Elysia hello action, [actions] (M3-F E8)`.

### Task 8: `scripts/sync-template.ts` (pokedex), `prepack`, the pack test

**Files:** NEW `scripts/sync-template.ts`, `template-overlays/pokedex/README.md.tmpl`, `test/sync-template.test.ts`, `test/pack.test.ts`; `test/cli.test.ts` (turn the Task 6 `todo` on).

- [ ] **Step 1: Failing tests.**
  - `test/sync-template.test.ts` (`syncTemplate({ from, to, overlay })` into `mkdtemp`, from the REAL `examples/pokedex`):
    1. `every kept file is byte-equal to its source; excluded paths absent (R4 list)`. Walk both trees; compare the sets.
    2. `package.json.tmpl: name/version/private, @brust/core = __BRUST_DEP__ unquoted, test script dropped, dev present, other deps verbatim`. After substituting `"^1.0.0"` it parses.
    3. `_gitignore = node_modules/, dist/ + examples/pokedex/.gitignore lines, deduped`.
    4. `README.md.tmpl comes from the overlay and contains __PROJECT_NAME__`.
    5. `re-sync removes a stale file in the output`.
    6. `throws when the source dependency is not workspace:*` (a temp `from` copy with `"@brust/core": "^1"`).
    7. `examples/pokedex is unchanged by a sync` (`git status --porcelain examples/pokedex` is empty).
  - `test/pack.test.ts`: `bun pm pack --destination <tmp>` in `packages/create-app`, then `tar -tzf`:
    1. `prepack generated templates/pokedex and it ships`: the listing has `package/templates/pokedex/routes.tsx`, `.../package.json.tmpl`, `.../_gitignore`, `.../data/pokedex.json` and `package/templates/blank/_gitignore`.
    2. `no node_modules/, dist/, test/, team.sqlite, .gitignore or .npmrc anywhere in the tarball`.
    3. `packed package.json: bin create-app, no workspace:, no dependencies`.
    4. `bin is executable in the tarball` (`tar -tvzf` mode `-rwxr-xr-x`).
- [ ] **Step 2: Implementation.** `scripts/sync-template.ts` exports `syncTemplate(opts?)` with the defaults `from = <repo>/examples/pokedex`, `to = <pkg>/templates/pokedex`, `overlay = <pkg>/template-overlays/pokedex`. It returns `{ files }`.
  - **Copy.** `rmSync(to, { recursive: true, force: true })`, then walk `from` and apply the R4 exclusions (`EXCLUDE_TOP = dist, test, README.md, package.json, .gitignore`; top-level `/^dist-/`; `node_modules`, `.DS_Store` and `*.tsbuildinfo` at any depth; `data/team.sqlite*`). Copy bytes with `copyFileSync`.
  - **`package.json.tmpl`.** Derive it per R6. `JSON.stringify(pkg, null, 2).replace('"__BRUST_DEP__"', '__BRUST_DEP__') + '\n'`. Throw `sync-template: examples/pokedex must depend on @brust/core workspace:* (got …)` otherwise.
  - **`_gitignore`.** Write it per R4.
  - **Overlay.** Copy the overlay files.
  - `if (import.meta.main) console.log(\`[sync-template] templates/pokedex: ${files} files\`)`.
  - The overlay `README.md.tmpl` is the pokedex README rewritten for a standalone app: no "from the repo root". It includes `bun run dev`, the `data/team.sqlite` reset, `POKEDEX_TEAM_DB` and the `bunx @tailwindcss/cli@4 …` regeneration line verbatim.
  - Wire `src/cli.ts` R5 (`if (tmpl.generated && monorepoRoot()) syncTemplate()`). If the directory is still missing (a broken published install), fail with `create-app: template directory not found at <dir>; this is a @brust/create-app installation bug`.
- [ ] **Step 3:**
  - `bun run build` → prints the file count.
  - `git status --short` shows nothing under `templates/pokedex`.
  - `bun test test/sync-template.test.ts test/pack.test.ts test/cli.test.ts` → pass.
  - Typecheck.
  - Commit `feat(create-app): pokedex template generated from examples/pokedex at prepack; tarball ships templates (R4/R5)`.

### Task 9: `test/scaffold.test.ts`: install → build → start → probe (slow)

**Files:** NEW `test/scaffold.test.ts`, `test/helpers.ts`.

- [ ] **Step 1: Harness** (`test/helpers.ts`):
  - `packAll(work)`: `bun pm pack --destination <work>/packs` in `packages/create-app`, `packages/brust` and `packages/runtime-dom`. Each must exit 0. Return the three `.tgz` paths: `brust-create-app-<v>.tgz`, `brust-core-<v>.tgz`, `brust-runtime-dom-<v>.tgz`.
  - `hostNative(work)`: glob `packages/brust/native/brust.*.node`. It needs exactly one match; otherwise throw `build the addon first: cd packages/brust && bun run build:debug`. Take `<plat>` from the name, copy `npm/<plat>/package.json` + the `.node` into `<work>/native-<plat>`, and return `{ name: '@brust/native-<plat>', dir }`.
  - `host(work, createAppTgz)`: `<work>/host/package.json` = `{ private: true, dependencies: { '@brust/create-app': 'file:<tgz>' } }`, then `bun install`.
  - `sh(cmd[], cwd, env?)`: `Bun.spawnSync`. On a non-zero exit it throws with stdout and stderr. The env clears `BRUST_PORT`, `BRUST_WORKERS` and `BRUST_ADDR` (`tests/server/harness.ts:9`).
  - `startApp(dir, env?)`: `bun run start --port 0 --workers 2` (exercises the template's `start` script). Read stdout until `/\[brust\] ready/`, take `base` from `/listening on (\S+)/`, and keep draining stdout. `stop()` = SIGINT, then SIGKILL after 5 s (the `harness.ts:6-31` pattern).
- [ ] **Step 2: Tests.** `beforeAll`: `mkdtemp`, `packAll`, `hostNative`, `host`. `afterAll`: `rm -rf work`. Each test has a 300 000 ms timeout.
  1. **`bun create @brust/app (packed create-app) scaffolds blank with long flags only`.**
     - Run `bun create @brust/app blank-app --template blank --dir <work>/apps/blank-app --brust-dep file:<core.tgz> --yes` (cwd `host`) → exit 0; stdout contains `Next:`.
     - The tree has no `.tmpl` and no `_gitignore`, has a `.gitignore`, and no file contains `__PROJECT_NAME__` or `__BRUST_DEP__`.
     - `package.json` name `blank-app`, `@brust/core` = `file:<core.tgz>`.
  2. **`blank: install → build → typecheck → start; / is the native counter; the hello action answers through Rust`.**
     - Inject `overrides` = `{ '@brust/runtime-dom': 'file:<rd.tgz>', [native.name]: 'file:<native.dir>' }`, then `bun install`, `bun run build`, `bun run typecheck` (`No type errors`), and `startApp`.
     - `GET /`: 200; the body contains `count is` and `x-data="counter_`, and every `<script type="module" src=…>` URL answers 200.
     - `GET /_brust/action/hello?name=ash`: 200 with JSON `{ message: 'Hello, ash!' }`.
     - `GET /_brust/action/nope`: 404 with `content-type` `application/problem+json` (Elysia answered, not Rust).
  3. **`pokedex: scaffold → install → build → start; /pokemon/pikachu renders; POST adds; SSR team shows it; a restart keeps it`.**
     - Scaffold with `--template pokedex`, the same way as test 1.
     - Assert `data/pokedex.json` exists, `data/team.sqlite` does NOT, and `test/` does not.
     - Overrides, `bun install`, `bun run build`, `startApp` (no `POKEDEX_TEAM_DB`, so the default `<cwd>/data/team.sqlite` is exercised).
     - `GET /pokemon/pikachu` → 200 and contains `Pikachu`.
     - `POST /_brust/action/team` with `{"id":25}` → 200, and `team` contains id 25.
     - `GET /` contains the TeamBuilder member marker recorded in Task 1.
     - `stop()`, then `startApp` again. `GET /_brust/action/team` still contains 25, and `data/team.sqlite` exists in the app dir.
  4. **`monorepo mode: blank without --brust-dep installs from file: + overrides and builds`.**
     - Run `bun <lane>/packages/create-app/bin/create-app.ts mono-app --template blank --dir <work>/apps/mono-app --yes`.
     - `@brust/core` = `file:<lane>/packages/brust`, and `overrides` has 7 keys.
     - `bun install` and `bun run build` → exit 0.
- [ ] **Step 3:** `cd packages/create-app && bun test --timeout 600000 test/scaffold.test.ts` → 4 pass. Paste the timings. Run it twice to check for flakes. Commit `test(create-app): scaffold both templates from packed tarballs — install, build, start, probe (M3-F §4.2/§4.3)`.

### Task 10: Release refs (`release-bump.ts`, `release.yml`) and CI lines

**Files:** `scripts/release-bump.ts`, `.github/workflows/release.yml`, `.github/workflows/ci.yml`.

- [ ] **Step 1: `release-bump.ts`.**
  - `FILES` gains `'packages/create-app/package.json'`; the `EXPECTED` comment becomes `// 9`.
  - The private check at `:35` covers create-app.
  - New verify: `packages/create-app` has no `dependencies` on `@brust/*`, because its version IS the dep spec (R3).
  - The header comment (`:2-4`) names the new ref.
  - Prove it on a scratch copy, never the lane tree: `cp -r` the repo's 9 `package.json` files + the script into `mkdtemp`, run `bun <tmp>/scripts/release-bump.ts 0.2.0-alpha.1`, and paste `✓ bumped 9/9`.
- [ ] **Step 2: `release.yml` (R7).**
  - `:66` loop → `for d in packages/runtime-dom packages/brust packages/create-app npm/*`.
  - After `:69` (and the same after `:103`):
    ```bash
    (cd packages/create-app && bun pm pack --destination /tmp/pack-ca) && tar -tzf /tmp/pack-ca/*.tgz > /tmp/ca.txt
    grep -qx 'package/templates/pokedex/routes.tsx' /tmp/ca.txt && grep -qx 'package/templates/blank/_gitignore' /tmp/ca.txt
    ! grep -Eq '/(node_modules|dist|test)/|team\.sqlite' /tmp/ca.txt
    ```
  - `:115` gains `pub packages/create-app @brust/create-app` (after core). `:116` loop gains `@brust/create-app`.
  - Validate with `bun -e "Bun.YAML?.parse ? 0 : 0"`, or `python3 -c 'import yaml,sys; yaml.safe_load(open(sys.argv[1]))' .github/workflows/release.yml`.
- [ ] **Step 3: `ci.yml`** (server job, after the `cd examples/pokedex && bun run typecheck` line):
  ```yaml
      # m3f-create-app: unit + pack, then the scaffold run (packs core/runtime-dom, bun install from npm, build, start) on its own.
      - run: cd packages/create-app && bun run typecheck && bun test test/args.test.ts test/copy.test.ts test/dep.test.ts test/templates.test.ts test/cli.test.ts test/sync-template.test.ts test/pack.test.ts
      - run: cd packages/create-app && bun test --timeout 600000 test/scaffold.test.ts
  ```
- [ ] **Step 4:** Commit `chore(release): @brust/create-app in release-bump, release.yml dry-run/publish, ci lines (R7)`.

### Task 11: Docs: `docs/create-app.md`, README quick start, package README

**Files:** NEW `docs/create-app.md`; `README.md`; `packages/create-app/README.md`.

- [ ] `docs/create-app.md` is one page: plain markdown, no front matter, like `docs/react-coverage.md`. Sections:
  1. **Quick start:** `bun create @brust/app my-app` → `cd my-app && bun install && bun run dev` → http://127.0.0.1:1337. Requires Bun ≥ 1.4 on one of the six native platforms (`npm/*`).
  2. **Options:** a table with `--template blank|pokedex` (default `blank`; a TTY asks), `--dir <path>`, `--yes` and `--brust-dep <spec>`. Add the note "`bun create` rejects `-t`/`-y`; use the long forms, or `bunx @brust/create-app my-app -t pokedex`" (R1). Name rules and the non-empty dir refusal.
  3. **Templates:** what `blank` and `pokedex` contain, and the scripts (`dev` = build + start until `brust dev` ships; `build`, `start`, `typecheck`).
  4. **The `@brust/core` version:** `^<version>`; from a brust checkout it is `workspace:*` or `file:` + `overrides` (R2); `--brust-dep` exists for CI and tarballs.
  5. **After scaffolding:** `brust.toml` `[server]`/`[actions]`, links to `docs/actions.md` and `docs/store.md`.
- [ ] `README.md`: after line 4, a `## Quick start` section with the three commands and a link to `docs/create-app.md`. Leave the existing bullets unchanged.
- [ ] `packages/create-app/README.md`: the npm landing page, holding the quick start, the options table and a link to the docs.
- [ ] Commit `docs: bun create @brust/app — docs/create-app.md and README quick start (M3-F §4.4)`.

### Task 12: Gates, evidence, READY

- [ ] **Step 1: Gates** (all green, pasted):
  - `cd packages/create-app && bun run typecheck && bun test test/args.test.ts test/copy.test.ts test/dep.test.ts test/templates.test.ts test/cli.test.ts test/sync-template.test.ts test/pack.test.ts`.
  - `cd packages/create-app && bun test --timeout 600000 test/scaffold.test.ts` (two runs, with timings).
  - `cd examples/pokedex && bun test && bun run typecheck`: unchanged, and `ls examples/pokedex/data` is the same as at Task 1.
  - `bun install --frozen-lockfile` at the lane root → no change.
  - The release-bump scratch proof (Task 10).
  - `git diff --name-only m3f` ⊆ Boundary, and `git status --short` is clean (the generated `templates/pokedex` is ignored).
- [ ] **Step 2: §4 acceptance by hand**, as a published user would run it. Paste the transcript.
  - From a scratch dir holding the packed create-app, run `bun create @brust/app demo --template pokedex --brust-dep file:<core.tgz>`, the overrides, `bun install`, `bun run build` and `bun run start`.
  - `curl` `/pokemon/pikachu`; POST team `{"id":25}`; `curl /`, which shows the member; restart; GET team.
  - The same for `blank`: `curl` the hello action. Optionally, one Chromium click on the counter (R10).
- [ ] **Step 3:** Post READY (template below). Do not merge.

## Review Focus

1. **`bun create` contract.** One bin named `create-app` with `#!/usr/bin/env bun`. Only long flags are documented for `bun create` (R1). A bare `--` is ignored and `--help` exits 0. The packed tarball runs through `bun create @brust/app` (scaffold test 1), not only through `bun bin/create-app.ts`.
2. **0.1.x parity.**
   - Name regex + 50-character limit, non-empty refusal, rollback of a created target, `blank` default for `--yes` and non-TTY.
   - A6 placeholders only in `.tmpl` files, `__BRUST_DEP__` JSON-encoded, `_gitignore` → `.gitignore`.
   - Test names port `tests/cli-new.test.ts` verbatim, apart from `minimal` → `blank` and the message prefix.
3. **Dependency spec (R2/R3).** Published = `^own version`, kept equal to core by release-bump. Monorepo detection uses exact markers with no walking. `file:` mode always carries the 7 overrides; `workspace:*` applies only inside a workspace glob. create-app has zero `dependencies`.
4. **The template is the real pokedex.** It is generated, never hand-edited, and every kept file is byte-equal (sync test 1). `test/`, the DB, `dist*` and `node_modules` are excluded. The derived `package.json.tmpl` keeps the elysia/eden pins verbatim. `examples/pokedex` is untouched by every gate.
5. **What is tested is the published shape.**
   - The tarball listing has the templates and has no `node_modules/`, `dist/`, `test/` or `team.sqlite`.
   - The scaffold test installs core and runtime-dom from `bun pm pack` tarballs, then builds, starts and probes both templates, including persistence across a restart.
   - The CI lines exist.
   - `release.yml` dry-runs, checks and publishes create-app after core.

## Risk ledger

| # | Risk | Mitigation |
|---|---|---|
| 1 | Bun rejects `-t`/`-y` under `bun create`, so users copying 0.1.x habits get `Invalid Argument` | R1: document long forms; the aliases remain for `bunx`; docs/create-app.md says so explicitly |
| 2 | Dual React or a second `elysia` copy in an installed app (0.1.x `file:` dual-React, `cli-new.test.ts:163-168`; elysia risk 3 `actions-elysia.md:614`) | Tarball installs (R8) carry no React or elysia copy of their own (both are peers of core); the pokedex scaffold test SSRs a react island and runs a POST through Elysia; monorepo `file:` mode is build-only tested |
| 3 | A shipped template that `files` does not filter: `node_modules/`, `dist/` and the DB would be packed (Facts) | The sync excludes them at the source; pack test 2 and the release.yml grep both fail on any |
| 4 | `templates/pokedex` is stale or missing | Generated at `prepack` (also on `bun publish`, Facts) and in monorepo runs (R5); a missing dir in a published install is a loud error |
| 5 | `__BRUST_DEP__ = ^0.0.0` until the first publish; `@brust/core` is 404 on npm | Tests always pass `--brust-dep`; the published path is unit-tested (dep test 2); the first prerelease is a human call |
| 6 | The scaffold test needs network (`bun install` of react, elysia beta, typebox) and is slow | Its own CI line with `--timeout 600000`; a per-test 300 s cap; timings pasted at READY; Bun's install cache is reused across tests |
| 7 | The pokedex lane's final shape differs from this plan (scripts, team marker, `.gitignore`, a new `../../` path) | Task 1 re-anchors; sync derives `package.json.tmpl` and `_gitignore` instead of hard-coding them; a monorepo path outside `test/` is a challenge, not a patch |
| 8 | `dist/native/` is empty in tarball installs (`build/index.ts:157-158`) | Out of this lane; reported in READY as an F-ledger candidate; `brust start` resolves the addon through the native package (probed) |
| 9 | The release-bump proof mutates the lane's `package.json` files | Run it only on a scratch copy (Task 10 Step 1) |

## Dispatch table

Lane tier: standard (one implementer; tasks run in order in one worktree) · review: standard (Review Focus 1–5).

| slug-task | tier | role | deps | acceptance (gate commands + READY evidence) |
|---|---|---|---|---|
| `m3f-create-app-1` merge + anchors | standard | implementer | the three wave-2 lanes merged into m3f; rulings answered | merge clean; anchor greps pasted (pokedex scripts/deps/.gitignore, team marker, `../../` hits); baseline gates green |
| `m3f-create-app-2` skeleton + args | standard | implementer | 1 | args tests red→green (ported names + 3 new); `bun.lock` only the new block; frozen-lockfile clean; typecheck; commit |
| `m3f-create-app-3` copy | standard | implementer | 2 | 6 copy tests pass; commit |
| `m3f-create-app-4` dep | standard | implementer | 2; R2, R3 | 7 dep tests pass (published, workspace, file+overrides, explicit, real-repo detection); commit |
| `m3f-create-app-5` templates registry | standard | implementer | 2 | 11 selection tests pass; commit |
| `m3f-create-app-6` main | standard | implementer | 3, 4, 5 | cli spawn tests pass (exit codes, help, tree, rollback, next steps); one `todo`; commit |
| `m3f-create-app-7` blank | standard | implementer | 6; R6, R9 | pins/files/toml/actions tests pass; commit |
| `m3f-create-app-8` sync + pack | standard | implementer | 7; R4, R5 | sync 7 + pack 4 pass; the cli `todo` is on and green; `examples/pokedex` untouched; commit |
| `m3f-create-app-9` scaffold e2e | standard | implementer | 8; R8, R10 | 4 scaffold tests pass twice, timings pasted; commit |
| `m3f-create-app-10` release + ci | standard | implementer | 9; R7 | release-bump scratch `✓ bumped 9/9`; release.yml parses; ci lines added; commit |
| `m3f-create-app-11` docs | standard | implementer | 9 | `docs/create-app.md`, README quick start, package README; commit |
| `m3f-create-app-12` gates + READY | standard | implementer | 10, 11 | all Task 12 gates + the §4 manual transcript pasted; READY posted |

## READY note template

```
READY lane/m3f-create-app @ <sha> (base m3f @ <sha after wave-2 merges>)
rulings: R1 long flags documented, -t/-y bunx-only · R2 <explicit|workspace|file+overrides|^version> · R3 own-version, exact markers · R4 test/ excluded · R5 generated+gitignored · R6 dev=build&&start · R7 release.yml <in|out> · R8 tarballs + host native dir · R9 <counter only|hello button> · R10 HTTP probes
package: @brust/create-app <ver> (= @brust/core <ver>), bin create-app, 0 dependencies, tarball <KB> / <N> files (templates/blank <n>, templates/pokedex <n>)
units: args <n> · copy 6 · dep 7 · templates <n> · cli <n> · sync 7 · pack 4 — typecheck clean
scaffold (2 runs): bun create→blank <s> · blank install/build/typecheck/start/probe <s> · pokedex install/build/start/POST/restart <s> · monorepo file: <s>
probes: blank / native counter ✓ · /_brust/action/hello?name=ash → {"message":"Hello, ash!"} · pokedex /pokemon/pikachu 200 · POST team {id:25} → team ∋ 25 · SSR team marker ✓ · after restart ∋ 25
release: release-bump scratch ✓ 9/9 · release.yml dry-run loop + create-app tarball grep + publish after core + dist-tag
ci: ci.yml server job +2 lines (units+pack; scaffold --timeout 600000)
docs: docs/create-app.md · README quick start · packages/create-app/README.md
gates: pokedex test+typecheck unchanged · examples/pokedex/data unchanged · frozen-lockfile clean · boundary diff clean
§4 manual transcript: <paste>
for the lead: dist/native empty in tarball installs (build/index.ts:157-158) — F-ledger candidate; first publish of @brust/create-app is a human call (tag push)
```
