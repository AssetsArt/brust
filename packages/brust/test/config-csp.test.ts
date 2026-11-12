// F539: `[csp]` in brust.toml / run({ config: { csp } }) -> cfg.csp (camelCase), validated like the Rust `CspConfig`, and handed to
// startServer and the Cloudflare CONFIG. Off unless `enabled = true`.
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cfCsp } from '../src/build/cloudflare'
import { BrustConfigError, cspSourceError, loadConfig, loadCsp, loadCspTable, voidsHashes, withCspEnv } from '../src/config'
import { cspOption, startOptions } from '../src/run'

const dirs: string[] = []
function tmpApp(toml?: string): string {
  const d = mkdtempSync(join(tmpdir(), 'brust-csp-'))
  dirs.push(d)
  if (toml !== undefined) writeFileSync(join(d, 'brust.toml'), toml)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function err(toml: string): Promise<string> {
  try {
    await loadConfig(tmpApp(toml))
  } catch (e) {
    expect(e).toBeInstanceOf(BrustConfigError)
    return (e as Error).message
  }
  throw new Error('expected loadConfig to throw')
}

test('off by default: no [csp], or enabled absent/false', async () => {
  expect((await loadConfig(tmpApp())).csp).toBeUndefined()
  expect((await loadConfig(tmpApp('[csp]\nstyle_src = ["\'unsafe-inline\'"]\n'))).csp).toBeUndefined()
  expect((await loadConfig(tmpApp('[csp]\nenabled = false\n'))).csp).toBeUndefined()
})

test('enabled maps snake_case -> camelCase, mode defaults to enforce', async () => {
  expect((await loadConfig(tmpApp('[csp]\nenabled = true\n'))).csp).toEqual({ mode: 'enforce' })
  const cfg = await loadConfig(
    tmpApp(
      `[csp]\nenabled = true\nmode = "report-only"\nscript_src = ["https://cdn.example"]\nstyle_src = ["'unsafe-inline'"]\nconnect_src = ["wss://ws.example"]\nimg_src = ["data:"]\nfont_src = ["https://fonts.example"]\nframe_ancestors = ["'none'"]\nreport_uri = "/csp-report"\n`,
    ),
  )
  expect(cfg.csp).toEqual({
    mode: 'report-only',
    scriptSrc: ['https://cdn.example'],
    styleSrc: ["'unsafe-inline'"],
    connectSrc: ['wss://ws.example'],
    imgSrc: ['data:'],
    fontSrc: ['https://fonts.example'],
    frameAncestors: ["'none'"],
    reportUri: '/csp-report',
  })
})

test('quoted keywords pass; ; , newlines, non-ASCII and unbalanced quotes are refused', () => {
  for (const s of ["'unsafe-inline'", "'self'", "'none'", "'nonce-abc'", "'sha256-AbC+/='", 'https://x.example', 'data:']) expect(cspSourceError(s)).toBeUndefined()
  for (const s of ['', ' ', 'a;b', 'a,b', 'a\nb', "'unsafe-inline", "x'", "'a' 'b'", 'é', "''"]) expect(cspSourceError(s)).toBeDefined()
})

test('validation errors name the file and the snake_case key', async () => {
  expect(await err('[csp]\nenabled = true\nstyle_src = ["a; script-src *"]\n')).toContain('csp.style_src')
  expect(await err('[csp]\nenabled = true\nreport_uri = "/r\\nx"\n')).toContain('csp.report_uri')
  expect(await err('[csp]\nenabled = true\nmode = "strict"\n')).toContain('csp.mode must be one of enforce, report-only')
  expect(await err('[csp]\nenabled = "yes"\n')).toContain('csp.enabled must be a boolean')
  expect(await err('[csp]\nenabled = true\nimg_src = "data:"\n')).toContain('csp.img_src must be an array of strings')
  // a misspelt directive is an error, not silently ignored (unlike [cors])
  expect(await err('[csp]\nenabled = true\nstyle-src = ["x"]\n')).toContain('csp.style-src is not a csp option')
  expect(await err('[csp]\nenabled = true\nscript_srcs = ["x"]\n')).toContain('csp.script_srcs is not a csp option')
  // checked even while off
  expect(await err('[csp]\nstyle_src = ["a;b"]\n')).toContain('csp.style_src')
})

test("'unsafe-inline' / 'unsafe-eval' in script_src need script_src_unsafe = true", async () => {
  for (const k of ["'unsafe-inline'", "'UNSAFE-EVAL'"]) {
    const m = await err(`[csp]\nenabled = true\nscript_src = ["${k}"]\n`)
    expect(m).toContain('script_src_unsafe = true')
    const cfg = await loadConfig(tmpApp(`[csp]\nenabled = true\nscript_src = ["${k}"]\nscript_src_unsafe = true\n`))
    expect(cfg.csp).toEqual({ mode: 'enforce', scriptSrc: [k], scriptSrcUnsafe: true })
  }
  expect((await loadConfig(tmpApp(`[csp]\nenabled = true\nstyle_src = ["'unsafe-inline'"]\n`))).csp?.styleSrc).toEqual(["'unsafe-inline'"])
})

// script-src sources that void the hashes / that do not: the same table as crates/brust-core/src/csp.rs (VOIDS / KEEPS).
const VOIDS = ["'unsafe-inline'", "'unsafe-eval'", "'unsafe-hashes'", 'data:', 'blob:', 'filesystem:', ' https: ', 'HTTP:', 'ws:', '*', 'https://*', 'HTTP://*', 'http://*', '*:443', '*:*', 'https://*:*', 'https://*/path', '*/x', 'wss://*:8443/a']
const KEEPS = ['https://cdn.example.com', '*.example.com', 'https://*.example.com', 'https://*.example.com:443', 'https://cdn.example.com/*', 'cdn.example.com:*', "'self'", "'wasm-unsafe-eval'", "'sha256-AbC='", "'nonce-x'"]

test('script_src refuses every source that voids the hashes; hosts and the other directives are free', async () => {
  for (const k of VOIDS) {
    expect([k, voidsHashes(k)]).toEqual([k, true])
    expect(await err(`[csp]\nenabled = true\nscript_src = ["${k}"]\n`)).toContain('script_src_unsafe = true')
    expect((await loadConfig(tmpApp(`[csp]\nenabled = true\nscript_src = ["${k}"]\nscript_src_unsafe = true\n`))).csp?.scriptSrc).toEqual([k])
  }
  for (const k of KEEPS) {
    expect([k, voidsHashes(k)]).toEqual([k, false])
    expect((await loadConfig(tmpApp(`[csp]\nenabled = true\nscript_src = ["${k}"]\n`))).csp?.scriptSrc).toEqual([k])
  }
  const free = await loadConfig(tmpApp(`[csp]\nenabled = true\nimg_src = ["data:", "blob:", "https:", "https://*"]\nstyle_src = ["*"]\n`))
  expect(free.csp).toEqual({ mode: 'enforce', imgSrc: ['data:', 'blob:', 'https:', 'https://*'], styleSrc: ['*'] })
})

test("'strict-dynamic' in script_src is refused, even with script_src_unsafe = true", async () => {
  for (const flag of ['', 'script_src_unsafe = true\n']) {
    const m = await err(`[csp]\nenabled = true\nscript_src = ["'strict-dynamic'"]\n${flag}`)
    expect(m).toContain("ignore 'self' and host sources")
    expect(m).toContain('nonces')
  }
  await expect(loadConfig(tmpApp(), { csp: { scriptSrc: [" 'STRICT-DYNAMIC' "], scriptSrcUnsafe: true } })).rejects.toThrow('config.csp.scriptSrc')
  expect((await loadConfig(tmpApp(`[csp]\nenabled = true\nstyle_src = ["'strict-dynamic'"]\n`))).csp?.styleSrc).toEqual(["'strict-dynamic'"])
})

test('run({ config: { csp } }) replaces the toml table as a whole; null turns it off; unknown keys refused', async () => {
  const dir = tmpApp('[csp]\nenabled = true\nimg_src = ["data:"]\n')
  expect((await loadConfig(dir, { csp: { styleSrc: ["'unsafe-inline'"] } })).csp).toEqual({ mode: 'enforce', styleSrc: ["'unsafe-inline'"] })
  expect((await loadConfig(dir, { csp: null })).csp).toBeUndefined()
  await expect(loadConfig(dir, { csp: { styleSrcs: [] } as never })).rejects.toThrow('config.csp.styleSrcs is not a csp option')
  await expect(loadConfig(dir, { csp: { scriptSrc: ["'unsafe-eval'"] } })).rejects.toThrow('config.csp.scriptSrc')
})

test('startServer gets csp only when on; the Cloudflare CONFIG gets reportOnly', async () => {
  const off = await loadConfig(tmpApp())
  expect('csp' in startOptions(off, '/d', {}, 'v')).toBe(false)
  const on = await loadConfig(tmpApp(`[csp]\nenabled = true\nmode = "report-only"\nstyle_src = ["'unsafe-inline'"]\n`))
  expect(startOptions(on, '/d', {}, 'v').csp).toEqual({ mode: 'report-only', styleSrc: ["'unsafe-inline'"] })
  // brust dev (a server with a dev token) sends none: its overlay adds <style> elements
  expect('csp' in startOptions(on, '/d', {}, 'v', 'dev-token')).toBe(false)
  expect(cfCsp(on.csp!)).toEqual({ enabled: true, reportOnly: true, styleSrc: ["'unsafe-inline'"] })
  const dir = tmpApp(`[csp]\nenabled = true\nframe_ancestors = ["'none'"]\n`)
  expect(await loadCsp(dir)).toEqual({ mode: 'enforce', frameAncestors: ["'none'"] })
  expect(await loadCsp(tmpApp('[csp]\nenabled = false\n'))).toBeUndefined()
})

// ---- F544 ----

test('F544 keys: default_src / base_uri (self | none), form_action and the new lists, dev / dev_mode', async () => {
  const cfg = await loadConfig(
    tmpApp(
      `[csp]\nenabled = true\ndefault_src = "none"\nbase_uri = "none"\nform_action = ["https://pay.example"]\nframe_src = ["https://v.example"]\nmedia_src = ["https://m.example"]\nworker_src = ["blob:"]\nmanifest_src = ["https://cdn.example"]\nobject_src = ["https://o.example"]\nconnect_src = ["wss://{host}"]\ndev = true\ndev_mode = "enforce"\n`,
    ),
  )
  expect(cfg.csp).toEqual({
    mode: 'enforce',
    defaultSrc: 'none',
    baseUri: 'none',
    formAction: ['https://pay.example'],
    frameSrc: ['https://v.example'],
    mediaSrc: ['https://m.example'],
    workerSrc: ['blob:'],
    manifestSrc: ['https://cdn.example'],
    objectSrc: ['https://o.example'],
    connectSrc: ['wss://{host}'],
    dev: true,
    devMode: 'enforce',
  })
  expect(await err('[csp]\nenabled = true\ndefault_src = "some"\n')).toContain('csp.default_src must be one of self, none')
  expect(await err('[csp]\nenabled = true\nbase_uri = "\'self\'"\n')).toContain('csp.base_uri must be one of self, none')
  expect(await err('[csp]\nenabled = true\ndev = "yes"\n')).toContain('csp.dev must be a boolean')
  expect(await err('[csp]\nenabled = true\ndev_mode = "off"\n')).toContain('csp.dev_mode must be one of enforce, report-only')
  expect(await err('[csp]\nenabled = true\nframe_src = ["a;b"]\n')).toContain('csp.frame_src')
  expect(await err('[csp]\nenabled = true\ndrop_host = true\n')).toContain('csp.drop_host is not a csp option')
})

test('{host} is refused in script_src (even with script_src_unsafe) and object_src, and allowed in every other list', async () => {
  expect(await err('[csp]\nenabled = true\nscript_src = ["https://{host}"]\nscript_src_unsafe = true\n')).toContain('uses {host}, which is refused here')
  expect(await err('[csp]\nenabled = true\nobject_src = ["https://{host}"]\n')).toContain("csp.object_src: https://{host} uses {host}, which is refused here: plugin sources stay 'none' or named hosts")
  for (const k of ['connect_src', 'img_src', 'style_src', 'form_action', 'frame_src', 'worker_src'])
    expect((await loadConfig(tmpApp(`[csp]\nenabled = true\n${k} = ["https://{host}"]\n`))).csp).toBeDefined()
})

test('BRUST_CSP_MODE: off, or report-only / enforce over the table (even when off) or the default policy; a bad value is an error', async () => {
  const off = { mode: 'enforce' as const, formAction: ['https://pay.example'] }
  expect(withCspEnv(undefined, off, undefined)).toBeUndefined()
  expect(withCspEnv(off, off, '')).toEqual(off)
  expect(withCspEnv(off, off, 'off')).toBeUndefined()
  expect(withCspEnv(undefined, off, 'report-only')).toEqual({ ...off, mode: 'report-only' })
  expect(withCspEnv(undefined, undefined, 'enforce')).toEqual({ mode: 'enforce' })
  expect(() => withCspEnv(off, off, 'strict')).toThrow('BRUST_CSP_MODE must be one of off, report-only, enforce (got "strict")')
  // through loadConfig, from the process environment
  const dir = tmpApp('[csp]\nenabled = false\nform_action = ["https://pay.example"]\n')
  const saved = process.env.BRUST_CSP_MODE
  try {
    process.env.BRUST_CSP_MODE = 'report-only'
    expect((await loadConfig(dir)).csp).toEqual({ mode: 'report-only', formAction: ['https://pay.example'] })
    process.env.BRUST_CSP_MODE = 'off'
    expect((await loadConfig(tmpApp('[csp]\nenabled = true\n'))).csp).toBeUndefined()
    process.env.BRUST_CSP_MODE = 'nope'
    await expect(loadConfig(dir)).rejects.toThrow('BRUST_CSP_MODE must be one of')
  } finally {
    if (saved === undefined) delete process.env.BRUST_CSP_MODE
    else process.env.BRUST_CSP_MODE = saved
  }
})

test('cspOption: none under brust dev unless dev = true (then dev_mode, report-only by default, plus the overlay style); a static render drops {host}', () => {
  const csp = { mode: 'enforce' as const, styleSrc: ['https://f.example'], connectSrc: ['wss://{host}'] }
  expect(cspOption(csp, 'tok', {})).toEqual({})
  expect(cspOption({ ...csp, dev: true }, 'tok', {})).toEqual({ csp: { mode: 'report-only', styleSrc: ['https://f.example', "'unsafe-inline'"], connectSrc: ['wss://{host}'] } })
  expect(cspOption({ ...csp, dev: true, devMode: 'enforce' }, 'tok', {}).csp?.mode).toBe('enforce')
  // brust start: as configured, without the dev keys
  expect(cspOption({ ...csp, dev: true, devMode: 'enforce' }, undefined, {})).toEqual({ csp })
  expect(cspOption(csp, undefined, { BRUST_SSG: '1' })).toEqual({ csp: { ...csp, dropHost: true } })
  expect(cspOption(undefined, undefined, {})).toEqual({})
})

test('the Cloudflare CONFIG carries the table when off too (enabled false), without the dev keys', async () => {
  const t = await loadCspTable(tmpApp('[csp]\ndev = true\nform_action = ["https://pay.example"]\n'))
  expect(t).toEqual({ enabled: false, csp: { mode: 'enforce', dev: true, formAction: ['https://pay.example'] } })
  expect(cfCsp(t!.csp, t!.enabled)).toEqual({ enabled: false, reportOnly: false, formAction: ['https://pay.example'] })
  expect(await loadCspTable(tmpApp())).toBeUndefined()
})
