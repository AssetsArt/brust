// F585 (AMENDMENT 1): a `brust build --dev` page renders byte-identical HTML to the production build for every job value
// of the matrix (the dev wrapper's extra tag decodes to the same value), the production jobs module carries no dev
// branch, and the dev server warns once per (component, slot, kind) only where a printing position prints an
// object-like value. An app object that has the wire tag's own key round-trips.
// Run alone: `bun test --timeout 120000 tests/server/job-values-dev.test.ts`.
import { afterAll, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/job-values')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
const KEYS = ['nan', 'inf', 'ninf', 'negzero', 'big', 'zerobig', 'num', 'obj', 'date', 'map', 'set', 'own']
const PATHS = KEYS.flatMap((k) => [`s/${k}`, `c/${k}`])

afterAll(() => rmSync(join(app, 'dist'), { recursive: true, force: true }))

/** Builds (dev or not), serves, fetches every path twice (the second answer from the job cache), returns bodies + log. */
async function serve(dev: boolean): Promise<{ bodies: Record<string, string>; log: string; jobs: string }> {
  const b = Bun.spawnSync([process.execPath, bin, 'build', 'routes.tsx', ...(dev ? ['--dev'] : [])], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}${b.stdout.toString()}`)
  const jobs = readFileSync(join(app, 'dist/jobs.js'), 'utf8')
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '', NO_COLOR: '1' }
  const proc = Bun.spawn([process.execPath, bin, 'start', '--port', '0', '--workers', '1'], { cwd: app, env, stdout: 'pipe', stderr: 'pipe' })
  let log = ''
  const drain = async (s: ReadableStream<Uint8Array>) => { const dec = new TextDecoder(); for await (const c of s) log += dec.decode(c, { stream: true }) }
  void drain(proc.stdout as ReadableStream<Uint8Array>)
  void drain(proc.stderr as ReadableStream<Uint8Array>)
  try {
    for (let i = 0; !/listening on (\S+)/.test(log) || !/\[brust\] ready/.test(log); i++) {
      if (i > 600) throw new Error(`no ready:\n${log}`)
      await Bun.sleep(50)
    }
    const base = `http://${/listening on (\S+)/.exec(log)![1]}`
    const bodies: Record<string, string> = {}
    for (const round of [0, 1])
      for (const p of PATHS) {
        const r = await fetch(`${base}/${p}`)
        const body = `${r.status} ${await r.text()}`
        if (round === 1) expect(body).toBe(bodies[p])
        bodies[p] = body
      }
    await Bun.sleep(200)
    return { bodies, log, jobs }
  } finally {
    proc.kill('SIGINT')
    if ((await Promise.race([proc.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) { proc.kill('SIGKILL'); await proc.exited }
  }
}

test('dev HTML is the production HTML; the dev server warns only where an object-like value is printed', async () => {
  const prod = await serve(false)
  const dev = await serve(true)
  // The production wrapper has no dev branch; the dev one has.
  expect(prod.jobs).not.toContain('instanceof Promise')
  expect(dev.jobs).toContain('instanceof Promise')
  for (const p of PATHS) {
    expect(prod.bodies[p].startsWith('200 ')).toBe(true)
    // The dev build's client scripts are other files (other hashes); the rendered markup is the same bytes.
    const markup = (b: string) => b.replace(/(\/_brust\/client\/[\w-]+?)-[0-9a-f]{10}\.js/g, '$1.js')
    expect(markup(dev.bodies[p])).toBe(markup(prod.bodies[p]))
  }
  // The app object carrying the tag's key is its own object again (printed like any object, not as NaN).
  expect(prod.bodies['s/own']).not.toContain('>NaN<')
  const warns = (log: string) => log.split('\n').filter((l) => l.includes('brust dev: component'))
  expect(warns(prod.log)).toEqual([])
  const w = warns(dev.log)
  // Server page: obj / date / map / set / own each printed as text and attribute (title, aria-hidden, data-v) by one
  // slot -> one warning per (component, slot, kind); the client page likewise. Never for a number or a bigint.
  for (const kind of ['object', 'Date', 'Map', 'Set']) expect(w.some((l) => l.includes(`(${kind === 'object' ? 'an' : 'a'} ${kind})`))).toBe(true)
  expect(w.some((l) => /\(an? (NaN|number|bigint)/.test(l))).toBe(false)
  const keys = w.map((l) => /component `([^`]+)` prints the job value `([^`]+)` \(an? (\w+)\)/.exec(l)!.slice(1).join('|'))
  expect(new Set(keys).size).toBe(keys.length)
}, 120_000)
