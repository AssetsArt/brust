// F252: `brust shadcn init` is imported inside its own command, so no other command loads the init module or its
// `tsconfig-paths` dependency (init.ts is the only importer). A Bun preload records loads of shadcn/init.ts; the control run is `shadcn init`.
// F253: the spawned shadcn CLI gets no TS_NODE_PROJECT / TS_NODE_BASEURL, and the pre-check ignores them too.
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cliEnv, shadcnInit, spawnRunner } from '../src/shadcn/init'

const bin = join(import.meta.dir, '../bin/brust')
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'brust-shadcn-lazy-')))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const spy = join(dir, 'spy.ts')
writeFileSync(
  spy,
  `import { appendFileSync, readFileSync } from 'node:fs'
Bun.plugin({ name: 'spy', setup(b) { b.onLoad({ filter: /shadcn\\/init\\.ts$/ }, (a) => {
  appendFileSync(process.env.SPY_LOG!, a.path + '\\n')
  return { contents: readFileSync(a.path, 'utf8'), loader: 'ts' }
}) } })
`,
)

function loaded(args: string[]): { code: number; modules: string[] } {
  const log = join(dir, `log-${Math.random().toString(36).slice(2)}`)
  writeFileSync(log, '')
  const p = Bun.spawnSync(['bun', '--preload', spy, bin, ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, SPY_LOG: log, BRUST_PORT: '' } })
  return { code: p.exitCode ?? -1, modules: readFileSync(log, 'utf8').split('\n').filter(Boolean) }
}

test('F252: shadcn init loads the init module (control: the spy sees it; it is the only importer of tsconfig-paths)', () => {
  const r = loaded(['shadcn', 'init'])
  expect(r.code).toBe(2) // no package.json here: usage-level refusal after the module loaded
  expect(r.modules.some((m) => m.includes('shadcn/init'))).toBe(true)
})

test('F252: other commands do not load the init module (so not tsconfig-paths)', () => {
  for (const args of [['frobnicate'], ['build', 'missing-routes.tsx', '--out-dir', join(dir, 'out')], ['start', '--dist-dir', join(dir, 'nope')]]) {
    const r = loaded(args)
    expect(r.code, args.join(' ')).not.toBe(0)
    expect(r.modules, args.join(' ')).toEqual([])
  }
})

test('F253: cliEnv drops the resolver variables and keeps the rest', () => {
  const e = cliEnv({ TS_NODE_PROJECT: 'x.json', TS_NODE_BASEURL: '.', PATH: '/bin', KEEP: '1' })
  expect(e).toEqual({ PATH: '/bin', KEEP: '1' })
})

test('F253: the spawned process does not see TS_NODE_PROJECT / TS_NODE_BASEURL set when brust started', () => {
  // the variables are in the environment of a fresh process (as a user would have them), which then spawns through spawnRunner
  const script = join(dir, 'spawn.ts')
  writeFileSync(
    script,
    `import { spawnRunner } from ${JSON.stringify(join(import.meta.dir, '../src/shadcn/init'))}
process.exit(await spawnRunner(['bun', '-e', 'process.exit(process.env.TS_NODE_PROJECT === undefined && process.env.TS_NODE_BASEURL === undefined && process.env.KEEP === "1" ? 0 : 3)'], process.cwd()))
`,
  )
  const p = Bun.spawnSync(['bun', script], { cwd: dir, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, TS_NODE_PROJECT: 'other.json', TS_NODE_BASEURL: 'elsewhere', KEEP: '1' } })
  expect(p.exitCode, p.stderr.toString()).toBe(0)
})

test('F253: the pre-check reads the project tsconfig even when TS_NODE_PROJECT names another file', async () => {
  const root = join(dir, 'proj')
  mkdirSync(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'a', dependencies: { '@brust/core': '^2.0.0-alpha.10' } }))
  writeFileSync(join(root, 'app.css'), '@import "tailwindcss";\n')
  writeFileSync(join(root, 'tsconfig.json'), '{ "compilerOptions": { "paths": { "@/*": ["./*"] } } }')
  const had = process.env.TS_NODE_PROJECT
  process.env.TS_NODE_PROJECT = join(dir, 'does-not-exist.json') // tsconfig-paths would throw on it
  try {
    const calls: string[][] = []
    const code = await shadcnInit({ root, components: ['button'], run: async (a) => (calls.push(a), 0), out: () => {} })
    expect(code).toBe(0)
    expect(calls.length).toBeGreaterThan(0)
  } finally {
    if (had === undefined) delete process.env.TS_NODE_PROJECT
    else process.env.TS_NODE_PROJECT = had
  }
})
