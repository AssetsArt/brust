// F411 (Assets Art B-9): `import face from './face.woff2'` is the served, hashed URL of the file, the same file and
// name the stylesheet's `url()` of it is rewritten to, so a layout can preload a stylesheet font. End to end with the
// real CLI on test/fixtures/font-app: the URL equals the one in the built CSS, the file is there, a static page's
// head has the preload, and a native component, a React island and a static page all carry the string.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const app = join(import.meta.dir, 'fixtures/font-app')
const bin = join(import.meta.dir, '../bin/brust')
let faceUrl = ''

function build(...args: string[]) {
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx', ...args], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build ${args.join(' ')} failed:\n${b.stderr}`)
}
const client = () => readdirSync(join(app, 'dist/client'))
const all = (dir: string): string[] => readdirSync(dir, { recursive: true }).map((f) => join(dir, String(f)))

beforeAll(() => {
  rmSync(join(app, 'dist'), { recursive: true, force: true })
  build()
  build('--target', 'static')
  const css = client().find((f) => /^face-[0-9a-f]{10}\.css$/.test(f))!
  faceUrl = `/_brust/client/${/url\(\.\/(face-[0-9a-f]{10}\.woff2)\)/.exec(readFileSync(join(app, 'dist/client', css), 'utf8'))![1]}`
}, 300_000)

afterAll(() => rmSync(join(app, 'dist'), { recursive: true, force: true }))

test('the import is the URL the built stylesheet uses, and the file is shipped once', () => {
  expect(faceUrl).toMatch(/^\/_brust\/client\/face-[0-9a-f]{10}\.woff2$/)
  expect(client().filter((f) => f.endsWith('.woff2'))).toEqual([faceUrl.split('/').pop()!])
  expect(Buffer.from(readFileSync(join(app, 'dist', faceUrl.replace('/_brust/', '')))).equals(readFileSync(join(app, 'fonts/face.woff2')))).toBe(true)
  expect(client().some((f) => /^mark-[0-9a-f]{10}\.png$/.test(f))).toBe(true)
})

test('a static page has the preload in its head, hoisted from the layout', () => {
  const html = readFileSync(join(app, 'dist/static/index.html'), 'utf8')
  const head = /<head>([\s\S]*?)<\/head>/.exec(html)![1]!
  expect(head).toContain(`<link rel="preload" as="font" type="font/woff2" crossorigin="" href="${faceUrl}">`)
  expect(readFileSync(join(app, 'dist/static/index.html'), 'utf8')).toContain(`id="plain" data-face="${faceUrl}"`)
  expect(existsSync(join(app, 'dist/static', faceUrl.replace(/^\//, '')))).toBe(true)
})

test('a native component and a React island both get the string', () => {
  const native = readFileSync(join(app, 'dist/static/native.html'), 'utf8')
  expect(native).toContain(`data-face="${faceUrl}"`)
  expect(native).toMatch(/<img id="mark" src="\/_brust\/client\/mark-[0-9a-f]{10}\.png"/)
  const island = readFileSync(join(app, 'dist/static/island.html'), 'utf8')
  const chunks = all(join(app, 'dist/client')).filter((f) => f.endsWith('.js')).map((f) => readFileSync(f, 'utf8'))
  expect(chunks.some((c) => c.includes(faceUrl))).toBe(true)
  expect(island).toContain('island')
})

test('--target cloudflare: the font is a Static Asset and the worker carries the URL', () => {
  const out = mkdtempSync(join(tmpdir(), 'brust-font-cf-'))
  try {
    const b = Bun.spawnSync([bin, 'build', 'routes.tsx', '--target', 'cloudflare', '--out-dir', out, '--force'], {
      cwd: app,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, BRUST_CORE_CF_DIR: join(import.meta.dir, 'fixtures/cf-core') },
    })
    expect([b.exitCode, b.stderr.toString()]).toEqual([0, ''])
    expect(readdirSync(join(out, 'cf/assets/_brust/client'))).toContain(faceUrl.split('/').pop()!)
    const worker = readdirSync(join(out, 'cf/worker'), { recursive: true }).map(String).filter((f) => f.endsWith('.js'))
    expect(worker.some((f) => readFileSync(join(out, 'cf/worker', f), 'utf8').includes(faceUrl))).toBe(true)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}, 120_000)

test('brust start serves the font at the URL, immutable, and the page names it in its preload', async () => {
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '' }
  const proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '1'], { cwd: app, env, stdout: 'pipe', stderr: 'inherit' })
  try {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
    const dec = new TextDecoder()
    let log = ''
    while (!/listening on|\[brust\] ready/.test(log)) {
      const { value, done } = await reader.read()
      if (done) throw new Error(`brust start exited:\n${log}`)
      log += dec.decode(value)
    }
    const base = /(https?:\/\/[^\s]+:\d+)/.exec(log)?.[1] ?? `http://127.0.0.1:${/:(\d+)/.exec(log)![1]}`
    const font = await fetch(base + faceUrl)
    expect([font.status, font.headers.get('cache-control')]).toEqual([200, expect.stringContaining('immutable')])
    expect(Buffer.from(await font.arrayBuffer()).equals(readFileSync(join(app, 'fonts/face.woff2')))).toBe(true)
    const page = await (await fetch(`${base}/native`)).text()
    expect(page).toContain(`<link rel="preload" as="font" type="font/woff2" crossorigin="" href="${faceUrl}">`)
  } finally {
    proc.kill()
  }
}, 60_000)
