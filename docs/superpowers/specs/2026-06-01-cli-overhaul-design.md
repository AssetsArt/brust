# CLI overhaul: help / version + `build --target` — design

Date: 2026-06-01 · Area: `runtime/cli/` · Status: spec · Base: `d1e05ad`

## Goal

Two cohesive improvements to the `brust` (`brustjs`) CLI:

1. **A polished, dep-free CLI shell** with proper `--help`/`-h`/`help [cmd]`,
   `--version`/`-v`/`version`, per-command help, aligned/colorized output (color
   gated on TTY + `NO_COLOR`), and friendly errors for unknown commands. Today
   `runtime/cli/index.ts` is a bare `switch` that only prints terse stderr lines
   and has no help/version at all.
2. **`brust build --target <auto|all|TARGET[,TARGET…]>` (default `auto`)** to pick
   which platform native binary(ies) get copied into the dist. Today
   `collectNativeBinaries` gathers every `brust.*.node` from `runtime/` + the host
   platform package and copies ALL of them unconditionally — there is no way to
   ask for "just my host" vs "everything" vs "this specific cross-target".

## Non-goals (explicit)

- **No external CLI/arg-parsing dependency** (commander, yargs, etc.). The repo
  deliberately avoids deps (cf. serde absent from the rust crate); the shell is
  hand-rolled. YAGNI: no plugin system, no shell-completion generation, no
  config file.
- **No cross-compilation / downloading of missing target binaries.** `--target`
  only SELECTS among `brust.*.node` files already present locally (in `runtime/`
  or installed `brustjs-<target>` optionalDependency packages). If a requested
  target's binary isn't present, it's a clear error, not a fetch.
- **No new `win32` target.** The valid target set is exactly the 6 published
  `optionalDependencies` (see below). `win32` isn't published, so it's not valid.
- **`dev` and `new` argument behavior is unchanged** beyond gaining `--help`
  routing. Their existing flags/parsing stay as-is.
- **No change to the bundled `dist/index.js`.** `index.ts` is the CLI bin run
  from source, not part of the app server bundle.

## Valid targets

The 6 published platform packages (root `package.json` `optionalDependencies`),
keyed by `<platform>-<arch>[-<libc>]` — identical to the napi binary infix
(`brust.<target>.node`) and the package suffix (`brustjs-<target>`):

```
darwin-x64   darwin-arm64
linux-x64-gnu   linux-arm64-gnu   linux-x64-musl   linux-arm64-musl
```

`auto` resolves to the host target via the existing host detection
(`process.platform`/`process.arch` + `linuxIsMusl()`), reusing the
`platformPackageName()` logic. `all` means every binary found locally.

## High-level architecture

### New module: `runtime/cli/help.ts`

The single source of truth for CLI metadata and rendering. Pure/string-returning
functions (no direct `console` calls) so they're unit-testable.

- `readVersion(): string` — read the brustjs `package.json` version. Resolve via
  `readFileSync(path.join(import.meta.dir, '../../package.json'))` — from
  `<root>/runtime/cli/help.ts` that is `<root>/package.json`, correct in both the
  source tree and an installed `node_modules/brustjs` layout. Parse JSON, return
  `version`. On any failure return `"unknown"` (never throw — version must not
  crash the CLI).
- A `style` helper: `const useColor = process.stdout.isTTY && !process.env.NO_COLOR`
  and functions `bold/dim/cyan/green/red(s): string` that wrap with ANSI only when
  `useColor`, else return `s` verbatim. (TTY check uses stdout so piped output is
  plain.)
- A `COMMANDS` registry — array of `{ name, summary, usage, flags: {flag, desc}[] }`
  for `build`, `dev`, `new`.
- `renderRootHelp(): string` — banner (`brust` + version), `Usage:
  brust <command> [options]`, a `Commands:` table (name + summary, aligned), and a
  footer (`Run brust help <command> for details.`).
- `renderCommandHelp(name): string | null` — per-command usage + flag table;
  `null` for an unknown name (caller treats as error).
- `renderVersion(): string` — `brust <version>` (or just the version — see Open
  questions, resolved: `brustjs <version>`).

### Rewrite: `runtime/cli/index.ts`

Dispatch order (first match wins), reading `process.argv.slice(2)`:

1. First token in `{--version, -v, version}` → print `renderVersion()` to stdout, exit 0.
2. First token in `{--help, -h}` OR `help` → if a second token names a command,
   print `renderCommandHelp(cmd)`; else print `renderRootHelp()`. stdout, exit 0.
   (`help <unknown>` → error to stderr + root help, exit 1.)
3. First token is `build|dev|new`:
   - If the command's own args contain `--help`/`-h`, print
     `renderCommandHelp(name)` to stdout, exit 0 (do NOT run the command).
   - Else `await run<Cmd>(rest)`.
4. No token → print `renderRootHelp()` to **stderr**, exit 1 (usage error, like
   `git`/`cargo`).
5. Unknown token → `brust: unknown command "<x>"` to stderr + a one-line
   `Run brust --help to see available commands.`, exit 1.

`index.ts` stays the thin dispatcher; all text lives in `help.ts`.

### `runtime/cli/build.ts` — `--target`

- Extend `ParsedArgs` with `target: string` (raw, default `'auto'`).
- `parseArgs`: accept `--target <v>` and `--target=<v>`. Keep existing
  `--out-dir` + positional entry handling. Unknown flags still error.
- New pure helper `selectNativeBinaries(collected: string[], target: string):
  { selected: string[]; errors: string[] }`:
  - Tokenize `target` on `,`, trim, lowercase.
  - `all` (alone) → return all `collected` (deduped by basename). Current behavior.
  - `auto` (alone) → resolve host target infix (reuse `platformPackageName()` →
    strip the `brustjs-` prefix to get the infix, e.g. `darwin-arm64`), select the
    `collected` entries whose basename is `brust.<infix>.node`.
  - explicit list → each token must be in the valid-target set (else an error
    string `unknown target "<t>" (valid: …)`); select `collected` entries matching
    `brust.<token>.node`. A token with no matching binary present → error string
    `no binary for target "<t>" — install brustjs-<t> or build it`.
  - `auto`/`all` may NOT be combined with other tokens (error).
  - Returns selected absolute paths (deduped) + any error strings.
- `runBuild`: after `collectNativeBinaries()`, call `selectNativeBinaries`. If
  `errors` non-empty → print each to stderr, exit 1. If `selected` empty (and no
  errors, e.g. `auto` but host binary absent) → keep the existing "no native
  binary found" error (augmented to mention the resolved target). Copy only
  `selected`. The `[brust build] native:` log lines are unchanged per file.

`selectNativeBinaries` and `parseArgs` are exported for unit tests (no full build
needed to cover target logic).

## CLI/API surface

```
brust <command> [options]

Commands:
  build [entry]   Compile a brust app to a self-contained dist/
  dev [entry]     Run the dev server with hot reload
  new <name>      Scaffold a new brust project

Global:
  -h, --help      Show help (brust help <command> for command help)
  -v, --version   Show the brustjs version

build options:
  [entry]              Entry file (default ./index.ts)
  --out-dir <dir>      Output directory (default ./dist)
  --target <t>         Native target(s) to bundle (default auto)
                       auto | all | <platform>-<arch>[-<libc>][,…]
                       e.g. darwin-arm64, linux-x64-gnu, linux-x64-musl
```

## File structure

```
runtime/cli/
  index.ts        # rewritten: pretty dispatcher (help/version/subcommands)
  help.ts         # NEW: version, color util, COMMANDS registry, render* fns
  build.ts        # +--target parse, +selectNativeBinaries, honor target on copy
  help.test.ts    # NEW: render* + readVersion unit tests
  build.test.ts   # NEW or extend: parseArgs(--target) + selectNativeBinaries
  dev.ts new.ts   # unchanged (help routed by index.ts)
```

## Tests

Unit (bun:test, no spawn — fast, leak-free):
1. `help.test.ts`: `readVersion()` returns the package.json version (matches
   `require('../../package.json').version`). `renderVersion()` contains it.
2. `renderRootHelp()` contains `Usage`, all three command names, and their
   summaries. `renderCommandHelp('build')` contains `--target` and `--out-dir`;
   `renderCommandHelp('bogus')` is `null`.
3. Color: with `NO_COLOR=1` (or non-TTY, which is the test default) the rendered
   strings contain NO `\x1b[` escapes.
4. `build.ts`: `parseArgs(['--target','all'])` → `target:'all'`;
   `parseArgs(['--target=darwin-arm64'])` → that value; default `'auto'`.
5. `selectNativeBinaries`:
   - given `['/x/brust.darwin-arm64.node','/x/brust.linux-x64-gnu.node']`:
     - `'all'` → both
     - `'darwin-arm64'` → only the darwin one
     - `'linux-x64-gnu,darwin-arm64'` → both
     - `'win32-x64'` → error (unknown target)
     - `'linux-arm64-musl'` (valid but absent) → error (no binary)
     - `'auto,all'` → error (not combinable)
   - `'auto'` selects the host binary — assert by computing the host infix the
     same way and checking membership (skip if host binary not in the fixture).

Integration (bun spawn — run ISOLATED, port-race/leak hygiene per memory
`bun-mock-module-leaks-suite`):
6. `brust --version` → stdout matches the package.json version, exit 0.
7. `brust --help` and `brust help build` → exit 0, stdout has the expected
   sections. `brust` (no args) → exit 1, help on stderr.
8. `brust frobnicate` → exit 1, stderr contains `unknown command`.
9. `brust build … --target darwin-arm64` against the example app → dist `native/`
   contains exactly `brust.darwin-arm64.node` (on a darwin-arm64 host) and the
   server still boots. (Gate/skip the exact-arch assertion to the host arch.)

The existing `cli-build.test.ts:118-120` assertion (`brust` → stderr
`'missing subcommand'`) is now wrong and must be **updated** to assert exit 1 +
help content (`Usage` / `Commands`).

## Acceptance criteria

- `brust --version`/`-v`/`version` prints the brustjs version; `brust --help`/`-h`/
  `help [cmd]` prints aligned, colorized-on-TTY help; `brust` no-arg and unknown
  command exit 1 with a helpful message.
- `brust build` default behavior = `--target auto` = host platform binary only.
  `--target all` reproduces today's "copy everything found" behavior. Explicit
  targets copy exactly those (error if absent/invalid).
- All existing CLI tests pass (with the one updated assertion). New unit +
  integration tests green. `biome check` clean on touched files.
- Output is plain (no ANSI) when piped or `NO_COLOR` is set.

## Known limitations (shipped)

- `auto`/explicit targets can only select binaries already present locally; no
  download/cross-compile.
- No `win32` target until it's published.
- No shell completion or man-page generation.

## Open questions — resolved at plan time

- **No-arg behavior?** → Print root help to stderr, exit 1 (usage error,
  git/cargo convention). Replaces the old `missing subcommand` line.
- **`renderVersion` format?** → `brustjs <version>` (the published bin name is
  `brustjs`; `brust` is the in-repo alias). Keep it greppable: the bare version
  substring is present.
- **Default `--target` when the host binary is multi-present in `runtime/` (CI
  matrix)?** → `auto` still resolves to the single host target; use `all` to get
  the whole matrix. This is a behavior change from "copy everything" but is the
  correct default for a developer building for their own machine; CI must pass
  `--target all`.
