// F486 C2 + plan A2(4): the Windows runtime proof. Scaffolds a blank app from the LOCAL packages (the published shape: packed
// create-app/core/runtime-dom, the host native as a file: dir) into a directory whose name is non-ASCII, with a page carrying
// Thai text, then: build, start on a free port, GET / = 200 with the marker and the Thai text, every client chunk the page links
// = 200 and free of a server-only marker, stop, rebuild over the existing dist (the P8 rename path), and finally a client import
// of a [build] server_only module must FAIL the build and leave dist usable (P3). A Windows stub that gets reached aborts the
// process with its own symbol name, which fails this script (and so the job).
// Run: bun scripts/windows-smoke.ts   (needs the addon built: cd packages/brust && bun run build)
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { host, hostNative, packAll, sh } from '../packages/create-app/test/helpers.ts'

const MARKER = 'SMOKE-SERVER-ONLY-MARKER-7f3a91'
const THAI = 'สวัสดีชาวโลก ทดสอบภาษาไทย'
const APP_DIR_NAME = 'แอป-é'
const step = (s: string) => console.log(`\n[smoke] ${s}`)
/** Throws (never `process.exit`s): the top-level catch below prints it, stops the server tree and exits 1, so a failure after start ends the step in seconds. */
function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

/** `bun run start --port 0` in the app; resolves once `[brust] ready` is printed. `stop` is what a user's process manager does: a plain kill of
 * the `bun run` wrapper (TerminateProcess on Windows: no process groups, no signal) and nothing else. F488: the server must notice its launcher
 * is gone and exit by itself, so within 10 s the port refuses connections and the app dir can be renamed (a live server holds it: EBUSY).
 * `cleanup` ends the whole tree with taskkill, only for the failure path. */
async function startServer(dir: string): Promise<{ base: string; stop: () => Promise<void>; cleanup: () => void }> {
  const proc = Bun.spawn(['bun', 'run', 'start', '--port', '0', '--workers', '2'], { cwd: dir, stdin: 'ignore', stdout: 'pipe', stderr: 'inherit', env: { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '' } })
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let out = ''
  while (!/\[brust\] ready/.test(out)) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`bun run start exited before ready:\n${out}`)
    out += dec.decode(value, { stream: true })
  }
  const base = `http://${/listening on (\S+)/.exec(out)![1]}`
  void (async () => {
    for (;;) if ((await reader.read()).done) return
  })()
  return {
    base,
    stop: async () => {
      if (process.platform === 'win32') proc.kill()
      else proc.kill('SIGINT')
      if ((await Promise.race([proc.exited, Bun.sleep(8000).then(() => undefined)])) === undefined) throw new Error('the launcher did not exit')
      if (process.platform !== 'win32') return
      const t0 = Date.now()
      let refused = false
      while (!refused && Date.now() - t0 < 10_000) {
        refused = await fetch(`${base}/`).then(() => false, () => true)
        if (!refused) await Bun.sleep(250)
      }
      check(refused, 'the server still answers 10 s after its launcher was killed (F488)')
      console.log(`[smoke] the server exited ${Date.now() - t0} ms after the launcher kill`)
      const moved = `${dir}-moved`
      renameSync(dir, moved) // a running server keeps the dir busy
      renameSync(moved, dir)
    },
    cleanup: () => {
      if (process.platform === 'win32') Bun.spawnSync(['taskkill', '/PID', String(proc.pid), '/T', '/F'], { stdout: 'ignore', stderr: 'ignore' })
      else proc.kill('SIGKILL')
    },
  }
}

// The runner's TEMP is an 8.3 short path (C:\Users\RUNNER~1\...): the same file under its short and its long spelling is two modules to Bun, so
// elysia loads twice ("two copies of elysia"). Work under the long (real) path, as a user's checkout is.
const work = realpathSync.native(mkdtempSync(join(tmpdir(), 'brust-smoke-')))
let cleanup: (() => void) | undefined
let failed = false
try {
  step('pack create-app, core, runtime-dom; host native')
  const tgz = packAll(work)
  const native = hostNative(work)
  check(native.name === '@brust/native-win32-x64-msvc' || process.platform !== 'win32', `host native is ${native.name}`)
  const hostDir = host(work, tgz.createApp)

  step(`scaffold blank into a non-ASCII dir (${APP_DIR_NAME})`)
  const dir = join(work, 'apps', APP_DIR_NAME)
  sh(['bun', 'create', '@brust/app', 'smoke-app', '--template', 'blank', '--dir', dir, '--brust-dep', `file:${tgz.core}`, '--yes'], hostDir)
  const pkgFile = join(dir, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
  pkg.overrides = { '@brust/runtime-dom': `file:${tgz.runtimeDom}`, [native.name]: `file:${native.dir}`, '@brust/core-cf': `file:${join(import.meta.dir, '..', 'npm', 'core-cf')}` }
  writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`)

  step('add the Thai text, a [build] server_only module used by an action')
  const home = join(dir, 'pages/HomePage.tsx')
  const homeSrc = readFileSync(home, 'utf8')
  check(homeSrc.includes('Edit pages/HomePage.tsx and save. The page reloads.'), 'HomePage.tsx changed shape: update the smoke')
  writeFileSync(home, homeSrc.replace('Edit pages/HomePage.tsx and save. The page reloads.', THAI))
  mkdirSync(join(dir, 'lib/server'), { recursive: true })
  writeFileSync(join(dir, 'lib/server/secret.ts'), `export const SECRET = '${MARKER}'\n`)
  const toml = join(dir, 'brust.toml')
  writeFileSync(toml, `${readFileSync(toml, 'utf8')}\n[build]\nserver_only = ["lib/server"]\n`)
  const actions = join(dir, 'actions.ts')
  writeFileSync(actions, `import { SECRET } from './lib/server/secret'\n${readFileSync(actions, 'utf8').replace("({ query }) => ({ message: `Hello, ${query.name ?? 'world'}!` }),\n)", "({ query }) => ({ message: `Hello, ${query.name ?? 'world'}!` }),\n).get('/secret-len', () => ({ n: SECRET.length }))")}`)

  step('bun install, bun run build')
  sh(['bun', 'install'], dir)
  sh(['bun', 'run', 'build'], dir)
  check(existsSync(join(dir, 'dist/manifest.json')), 'dist/manifest.json missing after build')

  step('bun run start on a free port; GET /')
  const app = await startServer(dir)
  cleanup = app.cleanup
  const page = await fetch(`${app.base}/`)
  check(page.status === 200, `GET / is ${page.status}`)
  const html = await page.text()
  check(html.includes('count is'), 'the app marker (count is) is missing from /')
  check(html.includes(THAI), 'the Thai text is missing or mangled in /')
  const chunks = [...new Set([...html.matchAll(/(?:src|href)="(\/_brust\/client\/[^"]+\.js)"/g)].map((m) => m[1]!))]
  check(chunks.length > 0, 'the page links no client chunk')
  for (const c of chunks) {
    const r = await fetch(`${app.base}${c}`)
    check(r.status === 200, `GET ${c} is ${r.status}`)
    check(!(await r.text()).includes(MARKER), `${c} contains the server-only marker`)
  }
  console.log(`[smoke] ${chunks.length} client chunk(s) served, none holds the server-only marker`)
  const sl = await fetch(`${app.base}/_brust/action/secret-len`)
  check(sl.status === 200 && ((await sl.json()) as { n: number }).n === MARKER.length, 'the action that imports the server-only module does not answer')

  step('stop the server with a plain kill of the launcher (F488), rebuild over the existing dist (the dist swap)')
  await app.stop()
  sh(['bun', 'run', 'build'], dir)
  check(existsSync(join(dir, 'dist/manifest.json')), 'dist/manifest.json missing after the rebuild')
  const leftovers = readdirSync(dir).filter((f) => f.includes('.brust-'))
  check(leftovers.length === 0, `build left temp dirs behind: ${leftovers.join(', ')}`)

  step('a client component importing a server_only module must fail the build and leave dist intact')
  const counter = join(dir, 'components/Counter.tsx')
  const counterSrc = readFileSync(counter, 'utf8')
  // The shape build-server-only.test.ts T1 uses: useTransition + useReducer cannot lower native, so Counter is a React island shipped to the browser.
  // (A useState + useEffect component lowers NATIVE: SECRET is then evaluated on the server and never bundled, so the build legitimately passes;
  // checked on POSIX at a5f4391f.)
  writeFileSync(
    counter,
    "import { useReducer, useTransition } from 'react'\nimport { SECRET } from '../lib/server/secret'\n\nexport default function Counter() {\n  useTransition()\n  const [n, hit] = useReducer((c: number) => c + 1, 0)\n  return (\n    <button type=\"button\" onClick={() => hit()}>\n      count is {n} {SECRET.length}\n    </button>\n  )\n}\n",
  )
  const leak = Bun.spawnSync(['bun', 'run', 'build'], { cwd: dir, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const leakOut = leak.stdout.toString() + leak.stderr.toString()
  if (leak.exitCode === 0) {
    const chunksDir = join(dir, 'dist/client')
    const hits = existsSync(chunksDir) ? readdirSync(chunksDir).filter((f) => f.endsWith('.js') && readFileSync(join(chunksDir, f), 'utf8').includes(MARKER)) : []
    console.error(`[smoke] build output:\n${leakOut}\n[smoke] chunks containing the marker: ${JSON.stringify(hits)}`)
    console.error(`[smoke] manifest tiers: ${JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(readFileSync(join(dir, 'dist/manifest.json'), 'utf8')).components as Record<string, { tier?: unknown }>).map(([k, v]) => [k, typeof v.tier === 'string' ? v.tier : Object.keys(v.tier ?? {})])))}`)
  }
  check(leak.exitCode !== 0, 'the build with a client import of a server_only module SUCCEEDED (server-only guard open)')
  check(/server-only/.test(leakOut), `the failed build does not name server-only:\n${leakOut}`)
  check(existsSync(join(dir, 'dist/manifest.json')), 'a failed build destroyed dist')
  writeFileSync(counter, counterSrc)

  console.log('\n[smoke] OK')
} catch (e) {
  failed = true
  console.error(`[smoke] FAIL: ${e instanceof Error ? e.message : String(e)}`)
} finally {
  cleanup?.()
  // Windows keeps a directory busy while a handle is open (an indexer, a just-exited child): retry, and never fail the run on cleanup.
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch (e) {
    console.warn(`[smoke] could not remove ${work}: ${(e as Error).message}`)
  }
}
process.exit(failed ? 1 : 0) // a leaked child must not keep the job open
