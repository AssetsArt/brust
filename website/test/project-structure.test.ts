// website/test/project-structure.test.ts — L28 part B: the Project structure page shows the Tailwind blank template
// (app.css at the root, Tailwind dev dependencies, the built CSS under dist/client), and Installation and CSS say so.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { projectStructureLoader } from '../pages/docs/ProjectStructure'
import { build, freshOut, HOOK_MS, serve, type Server } from './harness'

const TEMPLATE = join(import.meta.dir, '../../packages/create-app/templates/blank')

let base = ''
let srv: Server | undefined
let out = ''

beforeAll(async () => {
  out = freshOut('project-structure')
  build('routes.tsx', out, /^warning hook-unsupported (?!pages\/docs\/)/)
  srv = await serve(out)
  base = srv.base
}, HOOK_MS)

afterAll(async () => {
  await srv?.stop()
  freshOut('project-structure')
}, HOOK_MS)

/** Every file the generator writes, as it lands in the app: `_gitignore` → `.gitignore`, `x.tmpl` → `x`. */
function templateFiles(dir = TEMPLATE, rel = ''): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return templateFiles(path, `${rel}${name}/`)
    return [`${rel}${name.replace(/^_gitignore$/, '.gitignore').replace(/\.tmpl$/, '')}`]
  })
}

/** The tree block back to paths: `├── components/` then `│   └── Layout.tsx` → `components/Layout.tsx`. */
function treePaths(tree: string): string[] {
  const paths: string[] = []
  let dir = ''
  for (const line of tree.split('\n').slice(1)) {
    const m = /^(│   |    )?[├└]── (.+)$/.exec(line)
    if (!m) continue
    const name = m[2]!
    if (m[1]) paths.push(`${dir}${name}`)
    else if (name.endsWith('/')) dir = name
    else {
      dir = ''
      paths.push(name)
    }
  }
  return paths
}

test('the tree lists exactly the files the blank template writes, app.css at the root and none in public/', async () => {
  const { blocks } = await projectStructureLoader()
  expect(treePaths(blocks.tree.code).sort()).toEqual(templateFiles().sort())
  expect(treePaths(blocks.tree.code)).toContain('app.css')
  expect(treePaths(blocks.tree.code)).not.toContain('public/app.css')
})

test('every tree entry has a role in the file picker, and app.css says what it is', async () => {
  const { files } = await projectStructureLoader()
  const roles = new Map(files.map((f) => [f.path, f.role]))
  expect(roles.get('app.css')).toContain('Tailwind CSS v4')
  expect(roles.get('public/')).not.toContain('app.css')
  for (const f of ['routes.tsx', 'app.css', 'components/Layout.tsx', 'actions.ts', 'package.json', '.gitignore']) expect([f, roles.has(f)]).toEqual([f, true])
})

test("the scripts block is the template's scripts and devDependencies, Tailwind included", async () => {
  const { blocks } = await projectStructureLoader()
  const pkg = JSON.parse(readFileSync(join(TEMPLATE, 'package.json.tmpl'), 'utf8').replace('__BRUST_DEP__', '""'))
  expect(JSON.parse(blocks.scripts.code)).toEqual({ scripts: pkg.scripts, devDependencies: pkg.devDependencies })
  expect(pkg.devDependencies.tailwindcss).toMatch(/^4\./)
  expect(pkg.devDependencies['bun-plugin-tailwind']).toBeString()
})

test('the dist block names the built CSS under client/', async () => {
  const { blocks } = await projectStructureLoader()
  expect(blocks.dist.code).toContain('client/*.css')
})

test('the built pages: Project structure shows app.css and the dev deps; Installation and CSS point at the starter', async () => {
  const ps = await (await fetch(`${base}/docs/project-structure`)).text()
  // the docs site's own layout links /public/app.css, so look at the tree block only
  expect(ps).toContain('├── app.css\n')
  expect(ps).toContain('├── public/\n│   └── favicon.svg\n')
  expect(ps).toContain('bun-plugin-tailwind')
  expect(ps).toContain('.brust/dev')
  const inst = await (await fetch(`${base}/docs/installation`)).text()
  expect(inst).toContain('styled with Tailwind CSS v4')
  const css = await (await fetch(`${base}/docs/css`)).text()
  expect(css).toContain('The blank starter already ships both')
  expect(css).toContain('href="/docs/project-structure"')
  expect(css).not.toContain('scaffold with')
})
