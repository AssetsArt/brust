// F539: `[csp]` in brust.toml / run({ config: { csp } }) -> cfg.csp (camelCase), validated like the Rust `CspConfig`, and handed to
// startServer and the Cloudflare CONFIG. Off unless `enabled = true`.
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cfCsp } from '../src/build/cloudflare'
import { BrustConfigError, cspSourceError, loadConfig, loadCsp, voidsHashes } from '../src/config'
import { startOptions } from '../src/run'

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

test('script_src refuses every source that voids the hashes; hosts and the other directives are free', async () => {
  for (const k of ["'unsafe-hashes'", 'data:', 'blob:', 'filesystem:', '*', 'https:', 'HTTP:']) {
    expect(voidsHashes(k)).toBe(true)
    expect(await err(`[csp]\nenabled = true\nscript_src = ["${k}"]\n`)).toContain('script_src_unsafe = true')
    expect((await loadConfig(tmpApp(`[csp]\nenabled = true\nscript_src = ["${k}"]\nscript_src_unsafe = true\n`))).csp?.scriptSrc).toEqual([k])
  }
  for (const k of ['https://cdn.example.com', '*.example.com', 'https://*.example.com', "'self'", "'wasm-unsafe-eval'", "'sha256-AbC='", "'nonce-x'", "'strict-dynamic'"]) {
    expect(voidsHashes(k)).toBe(false)
    expect((await loadConfig(tmpApp(`[csp]\nenabled = true\nscript_src = ["${k}"]\n`))).csp?.scriptSrc).toEqual([k])
  }
  const free = await loadConfig(tmpApp(`[csp]\nenabled = true\nimg_src = ["data:", "blob:", "https:"]\nstyle_src = ["*"]\n`))
  expect(free.csp).toEqual({ mode: 'enforce', imgSrc: ['data:', 'blob:', 'https:'], styleSrc: ['*'] })
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
  expect(cfCsp(on.csp!)).toEqual({ reportOnly: true, styleSrc: ["'unsafe-inline'"] })
  const dir = tmpApp(`[csp]\nenabled = true\nframe_ancestors = ["'none'"]\n`)
  expect(await loadCsp(dir)).toEqual({ mode: 'enforce', frameAncestors: ["'none'"] })
  expect(await loadCsp(tmpApp('[csp]\nenabled = false\n'))).toBeUndefined()
})
