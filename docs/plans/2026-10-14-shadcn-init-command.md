# `brust shadcn init`: set up shadcn/ui in one command

owner: Detoro (lead) · authority: in-loop · ledger row **F175** · rules **R41.1–R41.10**

## 1. Why

The human, 2026-10-14: the setup guide (`/docs/guides/shadcn-setup`, `website/pages/docs/guides/ShadcnSetup.tsx`) reads like an automatic flow, but steps 2–3 are manual. The shadcn CLI's `init` stops on a brust project ("We could not detect a supported framework"). So the reader hand-writes `components.json`, edits `tsconfig.json`, installs four packages and runs `shadcn add index`. **Make it automatic with our own command, then rewrite the guide around it.**

Facts the command builds on are in `docs/transcripts/shadcn-setup-guide.md` (shadcn CLI 4.21.4, @brust 2.0.0-alpha.7). Two of them matter here: `add` works once `components.json` and the `@/*` path exist, and `add index` writes the theme into `app.css` and creates `lib/utils.ts`.

## 2. Shape (lead decision)

A subcommand of the existing CLI in `@brust/core` (`packages/brust/src/cli.ts`): **no new npm package**.

```sh
bunx brust shadcn init [component ...] [--yes] [--force] [--css <file>] [--base-color <name>]
```

The `blank` scaffold's `package.json` already runs `brust` through its scripts. Run from a project root, `bunx brust shadcn init button card dialog` takes a fresh project to step 4 of the guide. A `--shadcn` flag on `bun create @brust/app` is a later row (ledger), not this lane.

## 3. Rules

- **R41.1 Project check.** The command runs only in a brust project root: a `package.json` that depends on `@brust/core`. Otherwise it exits 2 with a one-line reason, before it writes anything.
- **R41.2 `components.json`.** Written only when it is absent. The content is the tested file (`tests/fixtures/shadcn/components.json`), with two inputs: `tailwind.css` is the project's Tailwind entry CSS (R41.3), and `baseColor` comes from `--base-color` (default `neutral`). An existing file is left untouched and reported, unless `--force` is given.
- **R41.3 CSS entry.** Use `--css` when it is given. Otherwise use the CSS file that the project's brust Tailwind setup reads (`app.css` in the `blank` template). When it cannot be determined, exit 2 and ask for `--css`; never guess.
- **R41.4 `tsconfig.json` path.** Add `"@/*": ["./*"]` under `compilerOptions.paths` when no `@/*` entry exists. The file is JSONC: edit it so that comments and formatting survive (a minimal text edit, or a JSONC-aware editor). Never rewrite it through `JSON.stringify`. An existing `@/*` with another target is left alone with a warning. A file the command cannot parse is not touched: print the exact line to add and continue.
- **R41.5 Dependencies.** Run `bun add radix-ui lucide-react class-variance-authority tw-animate-css`, skipping packages that are already in `dependencies`.
- **R41.6 shadcn CLI version.** Run the shadcn CLI at **one pinned, tested exact version**: a constant in the code, overridable by `--shadcn-version`. Do not run `@latest`. A release that moves the pin re-runs the transcript.
- **R41.7 Theme, then components.** Run `shadcn add index -y`. Skip it when `app.css` already has the shadcn theme block (`@import "shadcn/tailwind.css"`), unless `--force` is given. Then run `shadcn add <components...> -y` for each component named on the command line.
- **R41.8 No shell.** Every child process is spawned with an argv array (`Bun.spawn`), never through a shell string. A component name must match `^[a-z0-9][a-z0-9-]*$` or be an `https://` registry URL; anything else exits 2. A child that exits non-zero stops the command with that code and names the step that failed.
- **R41.9 Idempotent, with a report.** Running the command twice changes nothing the second time. Every step prints `done`, `skipped (reason)` or `failed`. At the end it prints what to do next (import from `components/ui`, add the route, `bun run build`).
- **R41.10 Tests without network.** Unit tests inject the process runner. They cover each R41.x branch: absent and present files, JSONC with comments, an existing `@/*`, a bad name, a child failure, and a second run. One real run on a fresh `bun create @brust/app` project (network, the pinned shadcn version) is recorded as the new transcript. That run ends in `bun run build` and a browser check that the dialog opens, as in the first transcript.

## 4. Guide rewrite (same lane, `website/`)

- Step 2 becomes **one command**: `bunx brust shadcn init button card dialog`, followed by the real output from the new transcript.
- A short list says what the command did: `components.json`, the `@/*` path, the four packages, `add index` (theme, `lib/utils.ts`), and the components.
- The manual steps (components.json, `paths`, `bun add`, `add index`) move to a section at the end, **"Doing it by hand"**, for projects that cannot run the command. The text is unchanged, and the reason (shadcn's `init` does not detect brust) is said once.
- The page states the version it needs: `@brust/core` **2.0.0-alpha.11 or later**. The command ships in alpha.11, and brust.dev deploys with that release.
- `website/test/shadcn-setup-page.test.ts` keeps checking the quoted files against the new transcript app directory.

## 5. Boundary, review, gates

- Files: `packages/brust/src/cli.ts` (dispatch and usage), a new `packages/brust/src/shadcn/` (the command), tests under `packages/brust/test/`, `website/pages/docs/guides/ShadcnSetup.tsx`, `website/test/shadcn-setup-page.test.ts`, `docs/transcripts/` (new transcript and app dir). No compiler or brust-core changes.
- Review: Afrojack (code). Mellow, a short security pass on R41.8 (child processes) and R41.4 (writing a user file).
- Gates: the TS gates (`bun run ci` biome, `bun test packages/brust`, the website tests). No cold cargo build is needed.
