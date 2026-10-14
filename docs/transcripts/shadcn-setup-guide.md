# Transcript: shadcn/ui on a fresh create-app project (L35, R38.1)

Run 2026-10-14 on macOS, Bun 1.4.3, published `@brust/*` 2.0.0-alpha.7, real `shadcn` CLI 4.21.4 (`bunx shadcn@latest`). The files of the final app that the guide quotes are in `docs/transcripts/shadcn-setup-guide-app/`.

## Findings (what the guide must say)

1. **`shadcn init` fails on a brust project** ("We could not detect a supported framework"; exit 1). Workaround: write `components.json` by hand (it is read by `add`).
2. **`shadcn add` needs the alias in `tsconfig.json`**: `"paths": { "@/*": ["./*"] }` is enough (no `baseUrl`). The CLI writes `@/components/ui/button` imports into the files it adds, and brust 2.0.0-alpha.7 builds them.
3. **`cn` is no longer a hand-written helper.** The current registry (new-york-v4) imports `cn` from the npm package `cn`; `shadcn add` installs it. `shadcn add index` also creates `lib/utils.ts` (`clsx` + `tailwind-merge`) for code that imports `@/lib/utils`.
4. **The theme comes from `shadcn add index`**: it adds `@import "tw-animate-css"`, `@import "shadcn/tailwind.css"`, `@custom-variant dark`, the light/dark CSS variables and `@theme inline` to `app.css`, and installs `shadcn` + `tw-animate-css`. Without it the classes (`bg-card`, `text-primary`) have no values.
5. **Result.** `/ui` with Card + Button builds and serves as static HTML with no page JavaScript; adding a Dialog makes one React island per Radix part (build warnings `external-component`, `spread-props`, `island-children` are the documented fallbacks); the dialog opens in a real browser (Playwright: click "Open" shows the dialog heading and text). Largest client chunk (shared React) 96.7 KB gzip.

## 1. Scaffold

```text
$ bun --version
1.4.3
$ bun create @brust/app@latest my-app --yes
Resolving dependencies
Resolved, downloaded and extracted [4]
Saved lockfile
@brust/create-app 2.0.0-alpha.7

Created my-app at /private/tmp/claude-501/-Users-detoro-code-brust/7944478e-8a95-4a84-ba5e-15a2eb4c708a/scratchpad/guide/my-app (template: blank, @brust/core ^2.0.0-alpha.7)

Next:
  cd ./my-app
  bun install
  bun run dev
```

## 2. Install (and the scaffold's files)

```text
$ cd my-app && bun install
+ elysia@2.0.0-beta.30
+ react@19.3.0
+ react-dom@19.3.0

74 packages installed [13.40s]

$ cat package.json tsconfig.json app.css routes.tsx
{
  "name": "my-app",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "brust dev routes.tsx",
    "build": "brust build routes.tsx",
    "start": "brust start",
    "typecheck": "bun check",
    "dev:cf": "brust dev routes.tsx --target cloudflare",
    "deploy:cf": "brust build routes.tsx --target cloudflare && wrangler deploy -c dist/cf/wrangler.jsonc"
  },
  "dependencies": {
    "@brust/core": "^2.0.0-alpha.7",
    "@elysia/eden": "2.0.0-beta.6",
    "elysia": "2.0.0-beta.30",
    "react": "^19.2.0",
    "react-dom": "^19.2.0"
  },
  "devDependencies": {
    "@tailwindcss/node": "4.3.3",
    "@tailwindcss/oxide": "4.3.3",
    "@types/bun": "^1.4.0",
    "@types/react": "^19.2.0",
    "tailwindcss": "4.3.3",
    "typescript": "^7.0.2",
    "wrangler": "^4.149.0"
  }
}
{
  "compilerOptions": {
    // Environment setup & latest features
    "lib": [
      "ESNext",
      "DOM",
      "DOM.Iterable"
    ],
    "target": "ESNext",
    "module": "Preserve",
    "moduleDetection": "force",
    "jsx": "react-jsx",
    "allowJs": true,
    "types": [
      "bun"
    ],
    // Bundler mode
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    // Best practices
    "strict": true,
    "skipLibCheck": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    // Some stricter flags (disabled by default)
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "noPropertyAccessFromIndexSignature": false
  },
  "exclude": [
    "dist",
    "node_modules"
  ]
}
@import "tailwindcss";

/* Tailwind CSS v4, CSS-first: no tailwind.config. The tokens below are the brust docs palette; each one becomes a
   utility (bg-paper, text-ink, border-rule, ...). A *.module.css that uses @apply starts with
   @reference "../app.css"; (see brust docs/css.md). */
@theme {
  --color-paper: oklch(94% 0.035 78);
  --color-sheet: oklch(97% 0.02 82);
  --color-ink: oklch(18% 0.035 82);
  --color-ink-2: oklch(36% 0.045 80);
  --color-rule: oklch(76% 0.05 77);
  --color-amber: oklch(68% 0.145 74);
  --color-amber-ink: oklch(46% 0.12 62);
  --font-sans: ui-rounded, "SF Pro Rounded", system-ui, sans-serif;
}

/* Dark mode follows the system: the same tokens, darker values, so every utility switches with them. */
@media (prefers-color-scheme: dark) {
  :root {
    --color-paper: oklch(20% 0.028 185);
    --color-sheet: oklch(24% 0.032 182);
    --color-ink: oklch(91% 0.02 82);
    --color-ink-2: oklch(77% 0.03 82);
    --color-rule: oklch(36% 0.032 180);
    --color-amber: oklch(74% 0.12 78);
    --color-amber-ink: oklch(81% 0.11 80);
  }
}

:root {
  color-scheme: light dark;
}
import { defineRoutes } from '@brust/core/routes'
import Layout from './components/Layout'
import HomePage from './pages/HomePage'

export const routes = defineRoutes([{ Component: Layout, children: [{ path: '/', Component: HomePage }] }])
components:
Counter.tsx
Layout.tsx

pages:
HomePage.tsx
```

## 3. CLI version and init help

```text
$ bunx shadcn@latest --version
Resolving dependencies
Resolved, downloaded and extracted [546]
Saved lockfile
4.21.4
$ bunx shadcn@latest init --help
Resolving dependencies
Resolved, downloaded and extracted [2]
Usage: shadcn init|create [options] [components...]

initialize your project and install dependencies

Arguments:
  components                 names, url or local path to component

Options:
  -t, --template <template>  the template to use. (next, start, vite,
                             react-router, laravel, astro)
  -b, --base <base>          the component library to use. (base, radix, aria)
  --monorepo                 scaffold a monorepo project.
  --no-monorepo              skip the monorepo prompt.
  -p, --preset [name]        use a preset configuration
  -y, --yes                  skip confirmation prompt. (default: true)
  -d, --defaults             use default configuration: --template=next
                             --preset=base-nova (default: false)
  -f, --force                force overwrite of existing configuration.
                             (default: false)
  -c, --cwd <cwd>            the working directory. defaults to the current
                             directory. (default:
                             "/private/tmp/claude-501/-Users-detoro-code-brust/7944478e-8a95-4a84-ba5e-15a2eb4c708a/scratchpad/guide/my-app")
  -n, --name <name>          the name for the new project.
  -s, --silent               mute output. (default: false)
  --css-variables            use css variables for theming. (default: true)
  --no-css-variables         do not use css variables for theming.
  --rtl                      enable RTL support.
  --no-rtl                   disable RTL support.
  --pointer                  enable pointer cursor for buttons.
  --no-pointer               disable pointer cursor for buttons.
  --reinstall                re-install existing UI components.
  --no-reinstall             do not re-install existing UI components.
  -h, --help                 display help for command
```

## 4. `shadcn init` does not recognise brust

```text
$ bunx shadcn@latest init -y -b radix -p nova
Resolving dependencies
Resolved, downloaded and extracted [2]
- Preflight checks.
✔ Preflight checks.
- Verifying framework.
✖ Verifying framework.

We could not detect a supported framework at /private/tmp/claude-501/-Users-detoro-code-brust/7944478e-8a95-4a84-ba5e-15a2eb4c708a/scratchpad/guide/my-app.
Visit https://ui.shadcn.com/docs/installation/manual to manually configure your project.
Once configured, you can use the cli to add components.

exit=1
```

## 5. Manual components.json + tsconfig paths, deps, `shadcn add button card dialog`

```text
$ bun add clsx tailwind-merge class-variance-authority radix-ui lucide-react tw-animate-css
Resolving dependencies
Resolved, downloaded and extracted [19]
Saved lockfile

installed clsx@2.1.1
installed tailwind-merge@3.7.0
installed class-variance-authority@0.7.1
installed radix-ui@1.8.1
installed lucide-react@1.56.0
installed tw-animate-css@1.4.0

79 packages installed [2.02s]
$ bunx shadcn@latest add button card dialog -y
Resolving dependencies
Resolved, downloaded and extracted [2]
- Checking registry.
✔ Checking registry.
- Installing dependencies.
- Installing dependencies.
✔ Installing dependencies.
- Updating files.
✔ Created 3 files:
  - components/ui/button.tsx
  - components/ui/card.tsx
  - components/ui/dialog.tsx
exit=0
```

## 6. `shadcn add index` (theme, tw-animate-css, lib/utils.ts)

```text
$ bunx shadcn@latest add index -y
Resolving dependencies
Resolved, downloaded and extracted [2]
- Checking registry.
✔ Checking registry.
- Installing dependencies.
- Installing dependencies.
✔ Installing dependencies.
- Updating files.
✔ Created 1 file:
  - lib/utils.ts
- Updating app.css
✔ Updating app.css
exit=0
$ curl -s -o /dev/null -w %{http_code} https://ui.shadcn.com/r/colors/neutral.json
200
```

## 7. Build with a Dialog page

```text
$ bun run build
$ brust build routes.tsx
warning external-component components/ui/dialog.tsx:11:10 <DialogPrimitive.Root> comes from the package radix-ui (Dialog.Root); it renders as a React island
warning spread-props components/ui/dialog.tsx:11:10 props are spread into the React island <DialogPrimitive.Root>
warning island-children components/ui/dialog.tsx:57:5 JSX children passed to the React island <DialogPortal> cannot be lowered: prop `className` of <DialogPrimitive.Content> is not a constant (a call to `cn`)
warning external-component components/ui/dialog.tsx:59:7 <DialogPrimitive.Content> comes from the package radix-ui (Dialog.Content); it renders as a React island
warning spread-props components/ui/dialog.tsx:59:7 props are spread into the React island <DialogPrimitive.Content>
warning island-children components/ui/dialog.tsx:59:7 JSX children passed to the React island <DialogPrimitive.Content> cannot be lowered: an expression that is not a constant (the prop `children`)
warning external-component components/ui/dialog.tsx:69:11 <DialogPrimitive.Close> comes from the package radix-ui (Dialog.Close); it renders as a React island
warning external-component components/ui/dialog.tsx:137:5 <DialogPrimitive.Description> comes from the package radix-ui (Dialog.Description); it renders as a React island
warning spread-props components/ui/dialog.tsx:137:5 props are spread into the React island <DialogPrimitive.Description>
warning external-component components/ui/dialog.tsx:37:5 <DialogPrimitive.Overlay> comes from the package radix-ui (Dialog.Overlay); it renders as a React island
warning spread-props components/ui/dialog.tsx:37:5 props are spread into the React island <DialogPrimitive.Overlay>
warning external-component components/ui/dialog.tsx:23:10 <DialogPrimitive.Portal> comes from the package radix-ui (Dialog.Portal); it renders as a React island
warning spread-props components/ui/dialog.tsx:23:10 props are spread into the React island <DialogPrimitive.Portal>
warning external-component components/ui/dialog.tsx:124:5 <DialogPrimitive.Title> comes from the package radix-ui (Dialog.Title); it renders as a React island
warning spread-props components/ui/dialog.tsx:124:5 props are spread into the React island <DialogPrimitive.Title>
warning external-component components/ui/dialog.tsx:17:10 <DialogPrimitive.Trigger> comes from the package radix-ui (Dialog.Trigger); it renders as a React island
warning spread-props components/ui/dialog.tsx:17:10 props are spread into the React island <DialogPrimitive.Trigger>
[brust] built dist in 546ms
$ brust build diagnostics?
app-94e00702d0.css
chunk-f69e1d234b.js
counter_4a7ef039-c0cfbc7fb8.js
react-dialog_395ca702-4efa424bc3.js
react-dialogContent_699b1868-ebceacef35.js
react-dialogDescription_766f44e0-7dfa60bea1.js
react-dialogOverlay_85866ffe-4a1198da79.js
react-dialogPortal_f2491e6b-2e0ebab05b.js
react-dialogTitle_a1fa1afb-909b740319.js
react-dialogTrigger_5156093a-fcbcd2a3c4.js
rt-basics-a5930e9f18.js
rt-for-7e01df008c.js
rt-html-ef3b71dac3.js
rt-if-47a45b78ad.js
rt-island-4832b980fc.js
rt-model-ab080eaddf.js
rt-store-7d4babb7b5.js
runtime-7853222a12.js
   96677 dist/client/chunk-f69e1d234b.js
     312 dist/client/counter_4a7ef039-c0cfbc7fb8.js
     824 dist/client/react-dialog_395ca702-4efa424bc3.js
     217 dist/client/react-dialogContent_699b1868-ebceacef35.js
     224 dist/client/react-dialogDescription_766f44e0-7dfa60bea1.js
     216 dist/client/react-dialogOverlay_85866ffe-4a1198da79.js
     214 dist/client/react-dialogPortal_f2491e6b-2e0ebab05b.js
     211 dist/client/react-dialogTitle_a1fa1afb-909b740319.js
     216 dist/client/react-dialogTrigger_5156093a-fcbcd2a3c4.js
     981 dist/client/rt-basics-a5930e9f18.js
    1103 dist/client/rt-for-7e01df008c.js
     357 dist/client/rt-html-ef3b71dac3.js
     414 dist/client/rt-if-47a45b78ad.js
     816 dist/client/rt-island-4832b980fc.js
     638 dist/client/rt-model-ab080eaddf.js
    1198 dist/client/rt-store-7d4babb7b5.js
    3138 dist/client/runtime-7853222a12.js
```

## 8. Is `baseUrl` needed? (tsconfig with `paths` only)

```text
$ (tsconfig has "paths" and no "baseUrl") bunx shadcn@latest add badge -y
Resolving dependencies
Resolved, downloaded and extracted [2]
- Checking registry.
✔ Checking registry.
- Updating files.
✔ Created 1 file:
  - components/ui/badge.tsx
exit=0
$ bun run build
warning spread-props components/ui/dialog.tsx:17:10 props are spread into the React island <DialogPrimitive.Trigger>
[brust] built dist in 305ms
```
