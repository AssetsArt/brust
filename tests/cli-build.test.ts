import { test, expect, afterAll } from 'bun:test'
import { spawn, $ } from 'bun'
import { existsSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const REPO = path.resolve(import.meta.dir, '..')

let distDir: string
let proc: ReturnType<typeof spawn> | undefined
const port = 38291

afterAll(async () => {
  if (proc) {
    proc.kill('SIGINT')
    await proc.exited
  }
})

test('brust build → run → smoke all major paths', async () => {
  distDir = await mkdtemp(path.join(tmpdir(), 'brust-dist-cli-test-'))

  // 1. Build
  const buildResult =
    await $`bun ${path.join(REPO, 'runtime/cli/index.ts')} build ${path.join(REPO, 'tests/fixtures/app/index.ts')} --out-dir ${distDir}`.nothrow()
  expect(buildResult.exitCode).toBe(0)

  // The server bundle keeps react/react-dom external (build.ts) so native-route
  // island SSR shares ONE React copy with the source islands it imports at
  // runtime. The dist therefore needs react resolvable from its own location;
  // link the repo's node_modules in. (A real project runs dist from inside the
  // project tree, where node_modules already resolves — this mirrors that.)
  symlinkSync(path.join(REPO, 'node_modules'), path.join(distDir, 'node_modules'), 'dir')

  // 2. Verify dist tree
  expect(existsSync(path.join(distDir, 'index.js'))).toBe(true)
  expect(existsSync(path.join(distDir, 'mcp-manifest.json'))).toBe(true)
  // No `_actions-prebuilt.ts`: `defineActions(...)` needs no build-time codegen —
  // the bundled entry registers actions via `brust.run({ actions })`.
  expect(existsSync(path.join(distDir, '_actions-prebuilt.ts'))).toBe(false)
  expect(existsSync(path.join(distDir, 'islands/_bootstrap.js'))).toBe(true)
  expect(existsSync(path.join(distDir, 'islands/_react.js'))).toBe(true)
  // Island chunks are content-addressed (`Counter_<hash>.js`); resolve the
  // actual filename for the existence + serve checks.
  const counterChunkFile = readdirSync(path.join(distDir, 'islands')).find((f) =>
    /^Counter_[a-f0-9]+\.js$/.test(f),
  )
  expect(counterChunkFile).toBeDefined()

  // native binary present (filename varies by platform — Darwin: brust.darwin-arm64.node,
  // Linux: brust.linux-x64-gnu.node, etc. — match the pattern build.ts uses).
  const { readdir } = await import('node:fs/promises')
  const nativeFiles = await readdir(path.join(distDir, 'native'))
  expect(nativeFiles.filter((f) => /^brust\..+\.node$/.test(f)).length).toBeGreaterThan(0)

  // 3. Banner injection
  const bundle = await Bun.file(path.join(distDir, 'index.js')).text()
  expect(bundle).toContain('process.env.BRUST_PREBUILT')
  expect(bundle).toContain('BRUST_DIST_DIR')

  // 4. Boot the prebuilt server
  proc = spawn({
    cmd: ['bun', 'run', path.join(distDir, 'index.js')],
    env: {
      ...process.env,
      BRUST_PORT: String(port),
      BRUST_WORKERS: '1',
      RUST_LOG: 'brust=warn',
    },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  await waitForPort(port, 10_000)

  // 5. Smoke major paths
  const ping = await fetch(`http://127.0.0.1:${port}/ping`)
  expect(ping.status).toBe(200)
  expect(await ping.text()).toBe('pong\n')

  const home = await fetch(`http://127.0.0.1:${port}/`)
  expect(home.status).toBe(200)
  expect(await home.text()).toMatch(/Hello/i)

  const counter = await fetch(`http://127.0.0.1:${port}/_brust/islands/${counterChunkFile}`)
  expect(counter.status).toBe(200)
  expect(counter.headers.get('content-type')).toContain('javascript')
  // The _islands.js map resolves the plain id → hashed chunk for the bootstrap.
  const islandsMap = await fetch(`http://127.0.0.1:${port}/_brust/islands/_islands.js`)
  expect(islandsMap.status).toBe(200)
  expect(await islandsMap.text()).toContain(`/_brust/islands/${counterChunkFile}`)

  // Native-route island SSR: /native-islands renders a `ssr: true` Counter
  // server-side. With react bundled into dist this hit "more than one copy of
  // React" (bundled react-dom vs the source island's node_modules react), the
  // renderToString failing, and the island silently degrading to client-only
  // (a React #418 hydration mismatch in the browser). Externalizing react fixes
  // it — assert the island is genuinely server-rendered (its button is in the
  // SSR HTML, not just hydrated client-side).
  const nativeIslands = await fetch(`http://127.0.0.1:${port}/_test/native-island-ssr`)
  expect(nativeIslands.status).toBe(200)
  expect(await nativeIslands.text()).toContain('data-testid="counter"')

  const mcp = await fetch(`http://127.0.0.1:${port}/_brust/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {} },
    }),
  })
  expect(mcp.status).toBe(200)
  const mcpBody = (await mcp.json()) as any
  expect(mcpBody.jsonrpc).toBe('2.0')
  expect(mcpBody.id).toBe(1)
  expect(mcpBody.result).toBeDefined()
}, 60_000)

test('brust build --target <hostInfix> copies exactly the host binary', async () => {
  // Compute host infix the same way build.ts does (mirrors platformPackageName + strip prefix).
  const { platform, arch } = process
  let hostInfix: string
  if (platform === 'linux') {
    // musl detection: absence of glibcVersionRuntime in process report
    let isMusl = false
    try {
      const report = process.report as { excludeNetwork?: boolean; getReport?: () => unknown }
      if (report && typeof report.getReport === 'function') {
        report.excludeNetwork = true
        const r = report.getReport() as { header?: { glibcVersionRuntime?: string } }
        isMusl = !r?.header?.glibcVersionRuntime
      }
    } catch {}
    hostInfix = `linux-${arch}-${isMusl ? 'musl' : 'gnu'}`
  } else {
    hostInfix = `${platform}-${arch}`
  }

  const targetDistDir = await mkdtemp(path.join(tmpdir(), 'brust-dist-target-test-'))
  try {
    const result =
      await $`bun ${path.join(REPO, 'runtime/cli/index.ts')} build ${path.join(REPO, 'tests/fixtures/app/index.ts')} --out-dir ${targetDistDir} --target ${hostInfix}`.nothrow()
    expect(result.exitCode).toBe(0)

    const { readdir } = await import('node:fs/promises')
    const nativeFiles = await readdir(path.join(targetDistDir, 'native'))
    const expected = `brust.${hostInfix}.node`
    expect(nativeFiles).toContain(expected)
    // Only the one requested target — not all platform binaries.
    expect(nativeFiles.filter((f) => /^brust\..+\.node$/.test(f)).length).toBe(1)
  } finally {
    const { rm } = await import('node:fs/promises')
    await rm(targetDistDir, { recursive: true, force: true })
  }
}, 60_000)

test('brust build with missing entry exits 1 with a clear message', async () => {
  const result =
    await $`bun ${path.join(REPO, 'runtime/cli/index.ts')} build /no/such/entry.ts`.nothrow()
  expect(result.exitCode).toBe(1)
  expect(result.stderr.toString()).toContain('no entry file at /no/such/entry.ts')
})

test('brust (no subcommand) exits 1', async () => {
  const result = await $`bun ${path.join(REPO, 'runtime/cli/index.ts')}`.nothrow()
  expect(result.exitCode).not.toBe(0)
  const noArgErr = result.stderr.toString()
  expect(noArgErr).toContain('Usage')
  expect(noArgErr).toContain('build')
})

test('brust build emits dist/css/app.css with compiled Tailwind', async () => {
  expect(existsSync(`${distDir}/css/app.css`)).toBe(true)
  const css = await Bun.file(`${distDir}/css/app.css`).text()
  // Tailwind v4 preflight signature — `*,` selector prefix (with optional spaces around comma).
  expect(css).toMatch(/\*,\s*::(?:before|after|backdrop)/)
  // A utility class actually used by the migrated example app.
  expect(css).toContain('.flex')
})

test('GET /_brust/css/app.css serves with correct headers', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/_brust/css/app.css`)
  expect(r.status).toBe(200)
  expect(r.headers.get('content-type') ?? '').toMatch(/^text\/css/)
  expect(r.headers.get('cache-control') ?? '').toMatch(/max-age=3600/)
  const text = await r.text()
  expect(text.length).toBeGreaterThan(100)
})

test('SSR HTML contains <link rel="stylesheet"> immediately before </head>', async () => {
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text()
  const linkTag = '<link rel="stylesheet" href="/_brust/css/app.css">'
  const linkIdx = html.indexOf(linkTag)
  const headEnd = html.indexOf('</head>')
  expect(linkIdx).toBeGreaterThan(-1)
  expect(headEnd).toBeGreaterThan(-1)
  expect(linkIdx).toBeLessThan(headEnd)
  // Nothing between the link tag and </head> (allowing 0 chars of slack).
  expect(headEnd - (linkIdx + linkTag.length)).toBe(0)
})

test('GET /_brust/css/..%2Fetc%2Fpasswd is 404', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/_brust/css/..%2Fetc%2Fpasswd`)
  expect(r.status).toBe(404)
})

// B6 regression: a prebuilt dist must serve native-route island props WITHOUT
// cwd/.brust present. The worker thread (not main) runs native render, so it
// must `configureJinjaDir(<distDir>/jinja)` at boot too — otherwise it falls
// back to `cwd/.brust/jinja`, which only happens to exist because `brust build`
// dual-emits there. Remove that crutch and the island's `data-brust-props`
// renders EMPTY → the client's `JSON.parse('')` throws "Unexpected end of JSON
// input" and the React island never hydrates. Build into an ISOLATED cwd so the
// removal never touches the repo's own `.brust`.
let proc2: ReturnType<typeof spawn> | undefined
const port2 = 38292
afterAll(async () => {
  if (proc2) {
    proc2.kill('SIGINT')
    await proc2.exited
  }
})

test('prebuilt dist serves native island props without cwd/.brust (worker configureJinjaDir)', async () => {
  const proj = await mkdtemp(path.join(tmpdir(), 'brust-proj-nobrust-'))
  const dist2 = await mkdtemp(path.join(tmpdir(), 'brust-dist-nobrust-'))

  // Build from the isolated cwd so `.brust` lands in `proj`, not the repo. The
  // entry stays the shared fixture (absolute path) — its island sourcePaths are
  // written project-relative to `proj` and rehydrated against cwd at runtime.
  const build =
    await $`bun ${path.join(REPO, 'runtime/cli/index.ts')} build ${path.join(REPO, 'tests/fixtures/app/index.ts')} --out-dir ${dist2}`
      .cwd(proj)
      .nothrow()
  expect(build.exitCode).toBe(0)

  // react/react-dom are external in the dist bundle — resolve them from the repo
  // (same copy the source islands import, so SSR shares one React).
  symlinkSync(path.join(REPO, 'node_modules'), path.join(dist2, 'node_modules'), 'dir')

  // Remove the dual-emit crutch: the worker must read <dist2>/jinja, not this.
  rmSync(path.join(proj, '.brust'), { recursive: true, force: true })

  proc2 = spawn({
    cmd: ['bun', 'run', path.join(dist2, 'index.js')],
    cwd: proj,
    env: { ...process.env, BRUST_PORT: String(port2), BRUST_WORKERS: '1', RUST_LOG: 'brust=warn' },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  await waitForPort(port2, 10_000)

  const html = await (await fetch(`http://127.0.0.1:${port2}/_test/native-island-ssr`)).text()
  // Props are present and non-empty (the exact SSR props the fixture passes).
  expect(html).toContain('data-brust-props="{&quot;start&quot;:5}"')
  expect(html).not.toContain('data-brust-props=""')
  // And the island genuinely server-rendered (mount markup present, not a bare shell).
  expect(html).toContain('data-testid="counter"')
}, 60_000)

// ── Task 2.8: md pages in `brust build` ──────────────────────────────────────

test('no-md fixture: dist carries ZERO md artifacts (byte-identical invariant)', () => {
  // Guards the md integration's no-op path: an app without mdRoutes() must
  // build the exact same dist as before the feature existed.
  expect(existsSync(path.join(distDir, 'md-manifest.json'))).toBe(false)
  const jinjaFiles = readdirSync(path.join(distDir, 'jinja'))
  expect(jinjaFiles.filter((f) => f.startsWith('Md_'))).toEqual([])
})

test('brust build with md routes → Md_*.jinja + md-manifest.json + md-only island chunk', async () => {
  const proj = await mkdtemp(path.join(tmpdir(), 'brust-proj-md-'))
  const mdDist = await mkdtemp(path.join(tmpdir(), 'brust-dist-md-'))
  try {
    // Isolated cwd: `.brust/` mirrors land in `proj`, never the repo.
    const build =
      await $`bun ${path.join(REPO, 'runtime/cli/index.ts')} build ${path.join(REPO, 'tests/fixtures/md-app/index.ts')} --out-dir ${mdDist}`
        .cwd(proj)
        .nothrow()
    if (build.exitCode !== 0) console.error(build.stderr.toString())
    expect(build.exitCode).toBe(0)

    // md jinja templates in the dist (one per content page).
    const jinjaFiles = readdirSync(path.join(mdDist, 'jinja'))
    expect(jinjaFiles.filter((f) => /^Md_.+\.jinja$/.test(f)).length).toBe(2)
    // …and mirrored into <cwd>/.brust/jinja (the source-runtime dual-emit).
    const mirrorFiles = readdirSync(path.join(proj, '.brust', 'jinja'))
    expect(mirrorFiles.filter((f) => /^Md_.+\.jinja$/.test(f)).length).toBe(2)

    // Frozen manifest next to BOTH jinja dirs (dist root + cwd/.brust).
    for (const file of [
      path.join(mdDist, 'md-manifest.json'),
      path.join(proj, '.brust', 'md-manifest.json'),
    ]) {
      expect(existsSync(file)).toBe(true)
      const manifest = JSON.parse(await Bun.file(file).text()) as {
        version: number
        entries: Array<{ relPath: string; urlPath: string; templateName: string }>
      }
      expect(manifest.version).toBe(1)
      expect(manifest.entries.map((e) => e.urlPath).sort()).toEqual(['/docs', '/docs/guide'])
      for (const e of manifest.entries) expect(e.templateName).toMatch(/^Md_/)
    }

    // The md-ONLY island (never referenced via <Island> in TSX) got a
    // content-addressed chunk + an _islands.js map entry.
    const islandFiles = readdirSync(path.join(mdDist, 'islands'))
    const chunk = islandFiles.find((f) => /^MdCounter_[a-f0-9]{8}\.js$/.test(f))
    expect(chunk).toBeDefined()
    const islandsMap = await Bun.file(path.join(mdDist, 'islands', '_islands.js')).text()
    expect(islandsMap).toContain(`/_brust/islands/${chunk}`)

    // The emitted template hosts the island marker with the SAME id the chunk
    // carries (marker ↔ chunk ↔ map coherence).
    const mdTemplate = jinjaFiles.find((f) => /^Md_index_md_[a-f0-9]{8}\.jinja$/.test(f))!
    const tmpl = await Bun.file(path.join(mdDist, 'jinja', mdTemplate)).text()
    expect(tmpl).toContain(`data-brust-island="${chunk!.replace(/\.js$/, '')}"`)
  } finally {
    const { rm } = await import('node:fs/promises')
    await rm(proj, { recursive: true, force: true })
    await rm(mdDist, { recursive: true, force: true })
  }
}, 60_000)

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/ping`, {
        signal: AbortSignal.timeout(500),
      })
      if (r.ok) return
    } catch {
      // not ready yet (connection refused, abort, etc.)
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`port ${port} did not start within ${timeoutMs}ms`)
}
