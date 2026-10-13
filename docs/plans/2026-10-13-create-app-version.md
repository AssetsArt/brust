# L30 create-app-version: `bun create @brust/app` prints its version (F131)

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: v2 @1622655a · flow: lane → PR → CI → lead merges · ledger row: F131

## Why

Human request, 2026-10-13 (screenshot of `bun create @brust/app@latest my-app`): "ตรงนี้ print version ด้วย". Today the run prints `Select a template:` … `Created my-app at … (template: blank)` and `Next:` with no version anywhere, so a user (or a bug report) cannot tell which create-app ran or which `@brust/core` range the app got.

## Rulings

- **R31.1 Banner first.** `main` prints one line before anything else (before the template prompt, also with `--yes`/`--template`, not with `--help`): `@brust/create-app <version>`, the version read from create-app's own `package.json` (the same file `bun publish` ships; read at run time, not hard-coded, so `release-bump.ts` stays the only place versions change). Then an empty line.
- **R31.2 The core range in the result line.** `Created my-app at <dir> (template: blank, @brust/core <spec>)`, where `<spec>` is the dependency spec actually written into the app's `package.json` (`^2.0.0-alpha.4`, `workspace:*`, `file:…`, or the `--brust-dep` value) — `resolveBrustDep`'s `spec`, not a second lookup.
- **R31.3 `--version`.** `--version` prints the bare version and exits 0 (no banner, nothing scaffolded); listed in `USAGE`. No `-v` (`bun create` rejects short flags before the bin runs; see the note in `args.ts`).
- **R31.4 Docs follow.** `docs/create-app.md` shows the new output (banner + result line) wherever it quotes the run; `website/pages/docs/Installation.tsx` / `Quickstart.tsx` only if they quote the output literally (check; Quickstart reads template files, not CLI output).
- **R31.5 Tests.** `packages/create-app/test/cli.test.ts` (banner is the first line and carries the package.json version; `--version` output and exit 0 with an empty target dir untouched; `--help` has no banner) and the result-line spec for the `version` and `explicit` dep kinds; `scaffold.test.ts` only if it asserts the old result line.

## Lane

| slug | tier | boundary | gates |
|---|---|---|---|
| `create-app-version` | standard | `packages/create-app/src/{cli.ts,args.ts}`, `packages/create-app/test/**`, `docs/create-app.md`, `website/pages/docs/{Installation,Quickstart}.tsx` only per R31.4, `docs/plans/m1a-followups.md` (F131) | `cd packages/create-app && bun run typecheck && bun test` (scaffold test included); terminal transcript of a real run (`bun packages/create-app/bin/… my-app --yes` in a scratch dir) as a task note; CI |
