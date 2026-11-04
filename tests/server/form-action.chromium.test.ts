// F483: the cookbook's form (website/pages/docs/cookbook/FormAction.tsx) builds native and works in real Chromium: a
// `const submit = async (e) => {…}` that awaits `api.team.post(...)` and sets the message. The fixture is the page's own code
// (checked below, so the page cannot drift from what is tested). The ids are posted from the form itself.
// Run alone: `bun test --timeout 120000 tests/server/form-action.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/form-action')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
const page = join(import.meta.dir, '../../website/pages/docs/cookbook/FormAction.tsx')
let proc: ReturnType<typeof Bun.spawn>
let base = ''
let browser: Browser

beforeAll(async () => {
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}`)
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '' }
  proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '1'], { cwd: app, env, stdout: 'pipe', stderr: 'inherit' })
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let out = ''
  while (!/\[brust\] ready/.test(out)) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`brust start exited before ready:\n${out}`)
    out += dec.decode(value, { stream: true })
  }
  base = `http://${/listening on (\S+)/.exec(out)![1]}`
  void (async () => {
    for (;;) {
      const { done } = await reader.read()
      if (done) return
    }
  })()
  browser = await chromium.launch()
}, 180_000)

afterAll(async () => {
  await browser?.close()
  proc?.kill('SIGINT')
  if ((await Promise.race([proc?.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) {
    proc.kill('SIGKILL')
    await proc.exited
  }
  rmSync(join(app, 'dist'), { recursive: true, force: true })
})

/** A code block of the cookbook page, as it renders (the template literal's escapes undone). */
function pageBlock(name: string): string {
  const m = new RegExp(`  ${name}: \\{[\\s\\S]*?code: \`([\\s\\S]*?)\`,\\n  \\},`).exec(readFileSync(page, 'utf8'))
  return m![1]!.replaceAll('\\`', '`').replaceAll('\\${', '${')
}

test('the fixture is the cookbook page\'s own code', () => {
  expect(readFileSync(join(app, 'actions.ts'), 'utf8')).toBe(`${pageBlock('actions')}\n`)
  expect(readFileSync(join(app, 'lib/api.ts'), 'utf8')).toBe(`${pageBlock('api')}\n`)
  expect(readFileSync(join(app, 'components/AddToTeam.tsx'), 'utf8')).toBe(`${pageBlock('form')}\n`)
})

test('the form compiles native: no React island, no per-request job naming the setter', async () => {
  const m = JSON.parse(readFileSync(join(app, 'dist/manifest.json'), 'utf8')) as { components: Record<string, { tier: string }> }
  const tier = Object.entries(m.components).find(([k]) => k.startsWith('addToTeam_'))![1].tier
  expect(tier).toBe('native')
  expect(await (await fetch(`${base}/`)).text()).not.toContain('brust-island')
})

test('submitting posts to the action and updates the message natively: success, the same id again, validation, a full team', async () => {
  const p = await browser.newPage()
  const errors: string[] = []
  p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  p.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errors.push(`console: ${m.text()}`))
  await p.goto(`${base}/`, { waitUntil: 'domcontentloaded' })
  await p.waitForFunction(() => document.querySelector('[x-data]') !== null)
  const msg = () => p.locator('form p').textContent()
  const submit = async (id: string, want: string) => {
    await p.locator('input[name="id"]').fill(id)
    await p.locator('button[type="submit"]').click()
    await p.waitForFunction((w) => document.querySelector('form p')?.textContent === w, want)
    expect(await msg()).toBe(want)
  }
  expect(await msg()).toBe('')
  await submit('25', 'Team: 1/6')
  await submit('25', 'Team: 1/6') // the same id is not added twice
  await submit('0', 'Failed with 422') // the schema refuses it
  for (const [i, id] of ['1', '2', '3', '4', '5'].entries()) await submit(id, `Team: ${i + 2}/6`)
  await submit('26', 'The team is full') // the seventh: 409
  // the only console noise is Chromium logging the two refusals the page handles itself (422, 409); no page error
  expect(errors).toEqual([
    'console: Failed to load resource: the server responded with a status of 422 (Unprocessable Entity)',
    'console: Failed to load resource: the server responded with a status of 409 (Conflict)',
  ])
  await p.close()
}, 90_000)
