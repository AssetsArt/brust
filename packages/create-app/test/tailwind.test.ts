// `--tailwind` (L21): the blank template's overlay. The installed, built and served app is scaffold.test.ts.
import { afterEach, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyTailwind, TAILWIND_DEV_DEPS } from '../src/tailwind.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

test('applyTailwind: app.css imports Tailwind, the layout imports app.css instead of /public/app.css, dev deps are pinned', () => {
  const d = mkdtempSync(join(tmpdir(), 'ca-tw-'))
  dirs.push(d)
  cpSync(join(import.meta.dir, '../templates/blank'), d, { recursive: true })
  cpSync(join(d, 'package.json.tmpl'), join(d, 'package.json'))
  const pkg = JSON.parse(readFileSync(join(d, 'package.json'), 'utf8').replace('__BRUST_DEP__', '"workspace:*"'))
  writeFileSync(join(d, 'package.json'), JSON.stringify(pkg))
  applyTailwind(d)
  expect(readFileSync(join(d, 'app.css'), 'utf8')).toStartWith('@import "tailwindcss";\n')
  const layout = readFileSync(join(d, 'components/Layout.tsx'), 'utf8')
  expect(layout).toContain("import '../app.css'\n")
  expect(layout).not.toContain('/public/app.css')
  expect(layout).toContain('<main className="mx-auto max-w-2xl p-6 font-sans">')
  expect(existsSync(join(d, 'public/app.css'))).toBe(false)
  expect(existsSync(join(d, 'public/favicon.svg'))).toBe(true)
  const after = JSON.parse(readFileSync(join(d, 'package.json'), 'utf8'))
  expect(after.devDependencies).toMatchObject(TAILWIND_DEV_DEPS)
  // the pins are the versions brust itself is tested with
  const root = JSON.parse(readFileSync(join(import.meta.dir, '../../../package.json'), 'utf8'))
  expect({ 'bun-plugin-tailwind': root.devDependencies['bun-plugin-tailwind'], tailwindcss: root.devDependencies.tailwindcss }).toEqual(TAILWIND_DEV_DEPS)
})
