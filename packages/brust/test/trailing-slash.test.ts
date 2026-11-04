// F506 `[server] trailing_slash`: the config layers, the build-time bake into the manifest, `brust start`'s mismatch check and the
// `--target static` warning. The request behaviour (308 / ignore / strict, base path, query, methods, brust's own paths) is the core
// pipeline's: crates/brust-server/tests/trailing_slash.rs serves it through the real server.
import { afterEach, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadBuildConfig } from '../src/build/config'
import { checkTrailingSlash, loadConfig } from '../src/config'
import { trailingSlashMismatch } from '../src/run'

const bin = join(import.meta.dir, '../bin/brust')
const fixture = join(import.meta.dir, 'fixtures/static-app')
const dirs: string[] = []
const tmp = (toml?: string) => {
  const d = mkdtempSync(join(tmpdir(), 'brust-ts-'))
  dirs.push(d)
  if (toml !== undefined) writeFileSync(join(d, 'brust.toml'), toml)
  return d
}
/** A copy of the static fixture inside the package (so `@brust/core` resolves) with a brust.toml. */
const app = (name: string, toml: string) => {
  const d = join(import.meta.dir, `fixtures/.trailing-${name}`)
  rmSync(d, { recursive: true, force: true })
  cpSync(fixture, d, { recursive: true, filter: (src) => !/[\\/]dist/.test(src) })
  writeFileSync(join(d, 'brust.toml'), toml)
  dirs.push(d)
  return d
}
const build = (cwd: string, ...args: string[]) => {
  const b = Bun.spawnSync([process.execPath, bin, 'build', 'routes.tsx', ...args], { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, BRUST_PORT: '', BRUST_ADDR: '' } })
  return { code: b.exitCode, log: b.stdout.toString() + b.stderr.toString() }
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

test('checkTrailingSlash: strict | redirect | ignore, anything else is refused with the choices', () => {
  for (const v of ['strict', 'redirect', 'ignore'] as const) expect(checkTrailingSlash(v)).toEqual({ ok: true, value: v })
  for (const bad of ['Redirect', 'off', '', true, null, 3]) {
    const r = checkTrailingSlash(bad)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.why).toContain('"strict", "redirect", "ignore"')
  }
})

test('[server] trailing_slash: toml and run({ config }) set it; nothing set leaves it absent (strict)', async () => {
  expect((await loadConfig(tmp())).trailingSlash).toBeUndefined()
  const dir = tmp('[server]\ntrailing_slash = "redirect"\n')
  expect((await loadConfig(dir)).trailingSlash).toBe('redirect')
  expect((await loadConfig(dir, { trailingSlash: 'ignore' })).trailingSlash).toBe('ignore')
  await expect(loadConfig(dir, { trailingSlash: 'nope' as never })).rejects.toThrow('config.trailingSlash must be one of')
  await expect(loadConfig(tmp('[server]\ntrailing_slash = "Redirect"\n'))).rejects.toThrow('server.trailing_slash must be one of')
})

test('the build reads [server] trailing_slash (default strict) and refuses a bad value', async () => {
  expect((await loadBuildConfig(tmp())).trailingSlash).toBe('strict')
  expect((await loadBuildConfig(tmp('[server]\nport = 3000\n'))).trailingSlash).toBe('strict')
  expect((await loadBuildConfig(tmp('[server]\ntrailing_slash = "ignore"\n'))).trailingSlash).toBe('ignore')
  await expect(loadBuildConfig(tmp('[server]\ntrailing_slash = 1\n'))).rejects.toThrow('server.trailing_slash must be one of')
})

test('brust start refuses a manifest built with another policy; a config that sets none takes the manifest', () => {
  expect(trailingSlashMismatch({ trailingSlash: undefined }, { trailing_slash: 'redirect' })).toBeNull()
  expect(trailingSlashMismatch({ trailingSlash: 'redirect' }, { trailing_slash: 'redirect' })).toBeNull()
  expect(trailingSlashMismatch({ trailingSlash: 'strict' }, {})).toBeNull()
  expect(trailingSlashMismatch({ trailingSlash: 'ignore' }, {})).toContain('trailing-slash-mismatch')
  expect(trailingSlashMismatch({ trailingSlash: 'strict' }, { trailing_slash: 'redirect' })).toContain('rebuild (brust build)')
})

test('brust build bakes a non-strict policy into the manifest; strict writes the manifest it always did', () => {
  const on = app('redirect', '[server]\ntrailing_slash = "redirect"\n')
  expect(build(on).code).toBe(0)
  expect(JSON.parse(readFileSync(join(on, 'dist/manifest.json'), 'utf8')).trailing_slash).toBe('redirect')
  const off = app('strict', '[server]\ntrailing_slash = "strict"\n')
  expect(build(off).code).toBe(0)
  expect('trailing_slash' in JSON.parse(readFileSync(join(off, 'dist/manifest.json'), 'utf8'))).toBe(false)
}, 120_000)

test('--target static warns that the static host decides trailing slashes, unless strict', () => {
  const b = build(app('static', '[server]\ntrailing_slash = "ignore"\n'), '--target', 'static')
  expect(b.code, b.log).toBe(0)
  expect(b.log).toContain('warning trailing-slash-static server.trailing_slash = "ignore" does not apply to --target static')
  const s = build(app('static-strict', '[server]\ntrailing_slash = "strict"\n'), '--target', 'static')
  expect(s.code, s.log).toBe(0)
  expect(s.log).not.toContain('trailing-slash-static')
}, 180_000)
