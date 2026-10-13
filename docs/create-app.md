# Create an app: `bun create @brust/app`

`@brust/create-app` scaffolds a brust v2 project. It has no dependencies, so running it never downloads the native addon.

## 1. Quick start

```bash
bun create @brust/app my-app
cd my-app
bun install
bun run dev        # brust dev routes.tsx (hot reload)  ->  http://127.0.0.1:1337
```

Requires Bun 1.4 or newer on a platform that has a native package (`@brust/native-<platform>`: darwin x64/arm64, linux x64/arm64 gnu and musl). Cloudflare Workers is a build target (`brust build --target cloudflare`); its prebuilt wasm, `@brust/core-cf`, installs with `@brust/core`. See [brust on Cloudflare Workers](./cloudflare.md) and, for a shared cache across instances, [Cache adapters](./cache-adapters.md).

## 2. Options

| Option | Meaning |
|---|---|
| `<name>` | The project name and, by default, the directory. Lowercase letters, digits, `-` and `_`; it starts with a letter or digit; at most 50 characters. |
| `--template blank\|pokedex` | The starting point. Default `blank`. Without the flag, an interactive terminal shows a picker; `--yes` or a non-interactive shell takes `blank`. |
| `--tailwind` | The `blank` template with Tailwind CSS v4 (see section 3). Only with `blank`. |
| `--dir <path>` | Scaffold into `<path>` instead of `./<name>`. |
| `--yes` | Accept defaults and never prompt. |
| `--brust-dep <spec>` | The `@brust/core` dependency to write (see section 4). For CI and tarball tests. |
| `--help` | Print the usage and exit. |

The target directory must be empty or absent; a directory that has files is refused. If the copy fails, a directory that the command created is removed again.

`bun create` rejects the short flags `-t` and `-y` itself, before the command runs. Use the long forms with `bun create`. The short forms work with `bunx`: `bunx @brust/create-app my-app -t pokedex -y`.

## 3. Templates

- **`blank`**: one layout, one page, one `useState` counter (compiled to a native component: a signal in the browser, no React shipped), and `actions.ts`, an Elysia 2 app on `brust()` with a `GET /hello` endpoint. `brust.toml` has `[server]` and `[actions]`.
- **`blank --tailwind`**: the same app with Tailwind CSS v4. `app.css` starts with `@import "tailwindcss";` and a `@theme` block. The layout imports it, and brust builds, minifies and links it (see [CSS](./css.md)). `public/app.css` is not included. `tailwindcss` and `bun-plugin-tailwind` are pinned dev dependencies.
- **`pokedex`**: the `examples/pokedex` app from this repository: loaders over an offline dataset, the L1 page cache, native components and a React island, and a persistent team (SQLite + Elysia actions + the unified store). It is generated from the example when the package is packed, so it never drifts from it. Its tests are not included.

Scripts in both: `dev` (build, then start, until `brust dev` ships), `build` (`brust build routes.tsx`), `start` (`brust start`), `typecheck` (`bun check`). `blank` also has `dev:cf` (build for Cloudflare Workers and run `wrangler dev`) and `deploy:cf` (build, then `wrangler deploy` of `dist/cf`).

## 4. The `@brust/core` version

- From npm, the project depends on `@brust/core` at `^<the version of @brust/create-app>`. Both packages are released together at one version.
- Inside a brust checkout, the dependency is `workspace:*` when the new project is inside a workspace glob (for example `examples/my-app`), and otherwise `file:<checkout>/packages/brust` plus an `overrides` block for `@brust/runtime-dom` and the six native packages (a `file:` core cannot resolve its own `workspace:*` dependencies outside the workspace).
- `--brust-dep <spec>` writes `<spec>` verbatim, with no overrides.

## 5. After scaffolding

- `brust.toml`: `[server]` (address, port) and `[actions]` (opt-in; defaults `entry = "actions.ts"`, `prefix = "/_brust/action"`). See [Actions](./actions.md).
- State shared by loaders, native components and islands: [The unified store](./store.md).
- The Elysia and Eden versions in `package.json` are exact pins of the current beta; bump them together with `@brust/core`.
- `wrangler.jsonc` (blank): your Cloudflare bindings; brust owns `main`, `assets` and `compatibility_date` (see [brust on Cloudflare Workers](./cloudflare.md)).
