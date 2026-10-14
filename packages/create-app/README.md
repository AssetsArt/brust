# @brust/create-app

Scaffold a [brust](https://github.com/AssetsArt/brust) v2 app.

```bash
bun create @brust/app my-app      # --template blank (default) | pokedex
bun create @brust/app my-app --shadcn=button,card,dialog   # also installs and runs `brust shadcn init` (needs @brust/core 2.0.0-alpha.11+)
cd my-app && bun install
bun run dev                       # http://127.0.0.1:1337
```

| Option | Meaning |
|---|---|
| `--template blank\|pokedex` | The starting point (default `blank`; a terminal asks when omitted). |
| `--dir <path>` | Target directory (default `./<name>`; it must be empty). |
| `--yes` | Accept defaults, never prompt. |
| `--brust-dep <spec>` | The `@brust/core` spec to write (CI and tarball tests). |

`bun create` rejects `-t` and `-y`; use the long flags (the short ones work with `bunx @brust/create-app`).

Full guide: [docs/create-app.md](https://github.com/AssetsArt/brust/blob/main/docs/create-app.md).
