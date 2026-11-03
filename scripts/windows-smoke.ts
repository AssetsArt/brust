// F486 C2 + plan A2(4): the Windows runtime proof. Scaffolds a blank app from the LOCAL packages (the published shape: packed
// create-app/core/runtime-dom, the host native as a file: dir) into a directory whose name is non-ASCII, with a page carrying
// Thai text, then: build, start on a free port, GET / = 200 with the marker and the Thai text, every client chunk the page links
// = 200 and free of a server-only marker, stop, rebuild over the existing dist (the P8 rename path), and finally a client import
// of a [build] server_only module must FAIL the build and leave dist usable (P3). A Windows stub that gets reached aborts the
// process with its own symbol name, which fails this script (and so the job).
// Run: bun scripts/windows-smoke.ts   (needs the addon built: cd packages/brust && bun run build)
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { host, hostNative, packAll, sh, startApp } from '../packages/create-app/test/helpers.ts'

const MARKER = 'SMOKE-SERVER-ONLY-MARKER-7f3a91'
const THAI = 'สวัสดีชาวโลก ทดสอบภาษาไทย'
const APP_DIR_NAME = 'แอป-é'
const step = (s: string) => console.log(`\n[smoke] ${s}`)
function check(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`[smoke] FAIL: ${msg}`)
    process.exit(1)
  }
}

// The runner's TEMP is an 8.3 short path (C:\Users\RUNNER~1\...): the same file under its short and its long spelling is two modules to Bun, so
// elysia loads twice ("two copies of elysia"). Work under the long (real) path, as a user's checkout is.
const work = realpathSync.native(mkdtempSync(join(tmpdir(), 'brust-smoke-')))
let stop: (() => Promise<void>) | undefined
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
  const app = await startApp(dir)
  stop = app.stop
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

  step('stop the server, rebuild over the existing dist (the dist swap)')
  await app.stop()
  stop = undefined
  sh(['bun', 'run', 'build'], dir)
  check(existsSync(join(dir, 'dist/manifest.json')), 'dist/manifest.json missing after the rebuild')
  const leftovers = readdirSync(dir).filter((f) => f.includes('.brust-'))
  check(leftovers.length === 0, `build left temp dirs behind: ${leftovers.join(', ')}`)

  step('a client component importing a server_only module must fail the build and leave dist intact')
  const counter = join(dir, 'components/Counter.tsx')
  const counterSrc = readFileSync(counter, 'utf8')
  writeFileSync(counter, `import { SECRET } from '../lib/server/secret'\n${counterSrc.replace('count is {count}', 'count is {count} {SECRET.length}')}`)
  const leak = Bun.spawnSync(['bun', 'run', 'build'], { cwd: dir, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const leakOut = leak.stdout.toString() + leak.stderr.toString()
  check(leak.exitCode !== 0, 'the build with a client import of a server_only module SUCCEEDED (server-only guard open)')
  check(/server-only/.test(leakOut), `the failed build does not name server-only:\n${leakOut}`)
  check(existsSync(join(dir, 'dist/manifest.json')), 'a failed build destroyed dist')
  writeFileSync(counter, counterSrc)

  console.log('\n[smoke] OK')
} finally {
  await stop?.().catch(() => {})
  rmSync(work, { recursive: true, force: true })
}
