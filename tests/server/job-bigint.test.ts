// F585 (AMENDMENT 2): a job value that is a bigint no longer fails the page with a 500: the reply carries it as its
// decimal digits, so text and attributes print what React prints. Known difference, kept: in a test the digits are a
// non-empty string, so `0n` is truthy on the server where JS reads it as false.
// Run alone: `bun test --timeout 120000 tests/server/job-bigint.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { firstDifference, normalise } from '../../scripts/battery/ssr-normalise.ts'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/job-bigint')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
let proc: ReturnType<typeof Bun.spawn>
let base = ''

beforeAll(async () => {
  const b = Bun.spawnSync([process.execPath, bin, 'build', 'routes.tsx'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}${b.stdout.toString()}`)
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '' }
  proc = Bun.spawn([process.execPath, bin, 'start', '--port', '0', '--workers', '1'], { cwd: app, env, stdout: 'pipe', stderr: 'inherit' })
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let out = ''
  while (!/\[brust\] ready/.test(out) || !/listening on (\S+)/.test(out)) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`brust start exited before ready:\n${out}`)
    out += dec.decode(value, { stream: true })
  }
  base = `http://${/listening on (\S+)/.exec(out)![1]}`
  void (async () => { for (;;) { const { done } = await reader.read(); if (done) return } })()
}, 180_000)

afterAll(async () => {
  proc?.kill('SIGINT')
  if ((await Promise.race([proc?.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) { proc.kill('SIGKILL'); await proc.exited }
  rmSync(join(app, 'dist'), { recursive: true, force: true })
})

const root = (html: string): string => html.slice(html.indexOf('<div'), html.lastIndexOf('</div>') + '</div>'.length)

const react = (k: string): string => {
  const script = join(app, '.react-render.tsx')
  writeFileSync(script, `import { renderToString } from 'react-dom/server'\nimport Page from './Page'\nprocess.stdout.write(renderToString(<Page x=${JSON.stringify(k)} />))\n`)
  const r = Bun.spawnSync([process.execPath, script], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  rmSync(script, { force: true })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
  return r.stdout.toString()
}

test('a bigint prints its digits in text, attribute, array item and nested member, as React does', async () => {
  const res = await fetch(`${base}/p/big`)
  expect(res.status).toBe(200)
  expect(firstDifference(normalise(root(await res.text())), normalise(react('big')))).toBeNull()
}, 60_000)

test('0n prints 0 but is truthy in a test (the known difference, kept)', async () => {
  const res = await fetch(`${base}/p/zerobig`)
  expect(res.status).toBe(200)
  const html = root(await res.text())
  expect(html).toContain('>0</p>')
  expect(html).toContain('<b>T</b>') // JS: 0n is falsy, React renders <i>F</i>
  expect(react('zerobig')).toContain('<i>F</i>')
}, 60_000)
