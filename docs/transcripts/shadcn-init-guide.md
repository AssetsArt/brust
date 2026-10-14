# Transcript: `brust shadcn init` on a fresh create-app project (F175, R41.10)

Run 2026-10-14 on macOS, Bun 1.4.4, `bun create @brust/app@latest` 2.0.0-alpha.10 (`@brust/core` ^2.0.0-alpha.10), the pinned shadcn CLI 4.21.4 (`bun x shadcn@4.21.4`). The files of the final app that the guide quotes are in `docs/transcripts/shadcn-init-guide-app/`.

## What is not the published artefact

`brust shadcn init` ships in 2.0.0-alpha.11, which is not published when this was run. The command line below is the one a reader types; the run itself executed the same entry (`bun packages/brust/src/cli.ts shadcn init button card dialog`) from the `shadcn-init` lane inside the project, because alpha.10 has no `shadcn` subcommand. Everything after it (the build, the serve, the browser) is the published alpha.10. Lines of shadcn's own spinner ("- Checking registry.") are filtered out of the output below; the exit code was 0.

## Findings

1. **One command** takes the fresh project to the state of step 4 of the old guide: `components.json`, the `@/*` path, the four packages, the theme (`add index`: `lib/utils.ts`, `app.css`), and the three components.
2. `components.json` written by the command is byte-identical to `tests/fixtures/shadcn/components.json`.
3. **Idempotent.** A second and third run changed nothing (`components.json`, `tsconfig.json`, `app.css`, `package.json` compared byte for byte) and printed `skipped (reason)` for every step.
4. **Resumes after a failed step.** On the very first attempt the pinned `bun x shadcn@4.21.4` died with `Cannot find module 'ms'`: the bunx temporary install of that exact version on this machine was incomplete (`ms` was missing from its `node_modules`). The command stopped at `shadcn add index` with that exit code and named the step; the earlier steps had finished. After deleting that temporary install directory (`$TMPDIR/bunx-<uid>-shadcn@4.21.4`) the same command was run again, skipped the finished steps and completed. A reader with a clean machine does not meet this; the guide does not mention it.
5. **Build and browser.** `/ui` (Card + Button + Dialog, `pages/ShadcnPage.tsx`) builds with the documented `external-component`, `spread-props` and `island-children` warnings (17 of them), serves, and in a real browser (Playwright) clicking "Open" shows the dialog with the heading "Hello" and the text "A Radix dialog, one React island."

## 1. The run

```text
$ bun --version
1.4.4
$ bun create @brust/app@latest my-app --yes
Resolving dependencies
Resolved, downloaded and extracted [2]
@brust/create-app 2.0.0-alpha.10

Created my-app at /home/you/my-app (template: blank, @brust/core ^2.0.0-alpha.10)

Next:
  cd ./my-app
  bun install
  bun run dev
$ cd my-app && bun install
+ react@19.3.0
+ react-dom@19.3.0

74 packages installed [3.47s]
$ bunx brust shadcn init button card dialog
✓ components.json: done (app.css)
✓ tsconfig.json: done (added "@/*": ["./*"] under compilerOptions.paths)
bun add v1.4.4-canary.1 (408c9374b)
Saved lockfile

installed radix-ui@1.8.1
installed lucide-react@1.57.0
installed class-variance-authority@0.7.1
installed tw-animate-css@1.4.0

78 packages installed [375.00ms]
✓ dependencies: done (radix-ui lucide-react class-variance-authority tw-animate-css)
✔ Checking registry.
✔ Installing dependencies.
✔ Created 1 file:
  - lib/utils.ts
✔ Updating app.css
✓ theme: done (shadcn@4.21.4 add index)
✔ Checking registry.
✔ Created 3 files:
  - components/ui/button.tsx
  - components/ui/card.tsx
  - components/ui/dialog.tsx
✓ button: done
✓ card: done
✓ dialog: done

next:
  import the components from './components/ui/<name>' in a page and add the route to routes.tsx
  bun run build
```

## 2. Use them in a route, build

`pages/ShadcnPage.tsx` and the `routes.tsx` edit are the ones in the guide.

```text
$ bun run build
warning external-component components/ui/dialog.tsx:11:10 <DialogPrimitive.Root> comes from the package radix-ui (Dialog.Root); it renders as a React island (package source: .brust/pkg-src/p-4ba0125d4d233615/src/dialog.tsx renders as React in its source: export is not a function declaration)
warning spread-props components/ui/dialog.tsx:11:10 props are spread into the React island <DialogPrimitive.Root>
…
[brust] built dist in 1208ms
```
