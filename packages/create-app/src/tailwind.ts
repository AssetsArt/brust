// `--tailwind` (gaps round L21): the blank template with Tailwind CSS v4. `app.css` imports Tailwind and the
// layout imports `app.css` (brust builds it and links it in <head>, L19); the plain `public/app.css` goes away;
// `tailwindcss` and `bun-plugin-tailwind` are pinned dev dependencies (R21.1: the app's own).
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The exact versions brust's own tests build with. */
export const TAILWIND_DEV_DEPS = { 'bun-plugin-tailwind': '0.1.2', tailwindcss: '4.3.3' }

const APP_CSS = `@import "tailwindcss";

/* Tailwind v4: theme tokens, then your own layers. A *.module.css that uses @apply starts with
   @reference "../app.css"; (see brust docs/css.md). */
@theme {
  --color-brand: oklch(0.55 0.2 260);
}
`

export function applyTailwind(dir: string): void {
  writeFileSync(join(dir, 'app.css'), APP_CSS)
  const layout = join(dir, 'components/Layout.tsx')
  let src = readFileSync(layout, 'utf8')
  const link = '        <link rel="stylesheet" href="/public/app.css" />\n'
  if (!src.includes(link)) throw new Error('create-app: --tailwind expects the blank layout (its /public/app.css link is missing)')
  src = src.replace(link, '')
  src = src.replace("import { Outlet } from '@brust/core/routes'\n", "import { Outlet } from '@brust/core/routes'\nimport '../app.css'\n")
  src = src.replace('<main>', '<main className="mx-auto max-w-2xl p-6 font-sans">')
  writeFileSync(layout, src)
  const pub = join(dir, 'public/app.css')
  if (existsSync(pub)) rmSync(pub)
  const pkgFile = join(dir, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
  pkg.devDependencies = { ...pkg.devDependencies, ...TAILWIND_DEV_DEPS }
  writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`)
}
