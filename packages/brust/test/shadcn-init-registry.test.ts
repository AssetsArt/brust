// F228: a registry URL item declares its own file targets, known only once it is fetched. The command fetches the item
// first (https only, size cap, timeout, no redirect to non-https), refuses a target outside the project or through a
// symlink, and hands the CLI the file it checked. Tests use a local http server through the `schemes` option.
import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shadcnInit } from '../src/shadcn/init'
import { fetchRegistryItem, ITEM_MAX_BYTES, vetItem } from '../src/shadcn/registry'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function project(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'brust-shadcn-reg-')))
  dirs.push(d)
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'a', dependencies: { '@brust/core': '^2.0.0-alpha.10' } }))
  writeFileSync(join(d, 'tsconfig.json'), '{ "compilerOptions": {} }')
  writeFileSync(join(d, 'app.css'), '@import "tailwindcss";\n')
  return d
}
const outsideDir = (): string => {
  const o = realpathSync(mkdtempSync(join(tmpdir(), 'brust-shadcn-reg-out-')))
  dirs.push(o)
  return o
}

const URL_ITEM = 'https://third.party.dev/r/acme-card.json'
const item = (over: Record<string, unknown> = {}): string => JSON.stringify({ name: 'acme-card', type: 'registry:ui', files: [{ path: 'registry/acme/ui/acme-card.tsx', type: 'registry:ui' }], ...over })

async function init(root: string, text: string | Error, extra: string[] = []) {
  const calls: string[][] = []
  const lines: string[] = []
  const copies: string[] = []
  const code = await shadcnInit({
    root,
    components: [URL_ITEM, ...extra],
    run: async (argv) => {
      calls.push(argv)
      for (const a of argv) if (a.endsWith('.json') && existsSync(a)) copies.push(readFileSync(a, 'utf8'))
      return 0
    },
    out: (s) => lines.push(s),
    fetchItem: async () => {
      if (text instanceof Error) throw text
      return text
    },
  })
  return { code, calls, copies, text: lines.join('\n') }
}

const refused = async (name: string, text: string | Error, set?: (d: string, outside: string) => void) => {
  const d = project()
  const outside = outsideDir()
  set?.(d, outside)
  const r = await init(d, text)
  expect(r.code, name).toBe(2)
  expect(r.calls, name).toEqual([])
  expect(existsSync(join(d, 'components.json')), name).toBe(false) // nothing written before the refusal
  expect(readdirSync(outside), name).toEqual([])
  return r
}

test('F228: a clean item runs; the CLI is given a copy of exactly the JSON that was checked, removed afterwards', async () => {
  const d = project()
  const text = item({ files: [{ path: 'registry/acme/ui/acme-card.tsx', type: 'registry:ui' }, { path: 'registry/acme/notes.md', type: 'registry:file', target: '~/docs/acme.md' }] })
  const r = await init(d, text)
  expect(r.code).toBe(0)
  expect(r.copies).toEqual([text])
  expect(r.calls.at(-1)!.some((a) => a === URL_ITEM)).toBe(false)
})

test('F228: a declared target that is, or is under, a symlink is refused before anything is written', async () => {
  const link = (rel: string) => (d: string, outside: string) => {
    mkdirSync(join(d, rel, '..'), { recursive: true })
    symlinkSync(outside, join(d, rel))
  }
  await refused('~/ target through a linked directory', item({ files: [{ path: 'a.md', type: 'registry:file', target: '~/docs/acme.md' }] }), link('docs'))
  await refused('plain target through a linked directory', item({ files: [{ path: 'a.ts', type: 'registry:file', target: 'server/acme.ts' }] }), link('server'))
  await refused('a target that is itself a link', item({ files: [{ path: 'a.ts', type: 'registry:file', target: 'app/acme.ts' }] }), (d, o) => {
    mkdirSync(join(d, 'app'))
    symlinkSync(join(o, 'acme.ts'), join(d, 'app/acme.ts'))
  })
  // src/ projects: the CLI may write the target under src/
  await refused('src/ variant', item({ files: [{ path: 'a.ts', type: 'registry:file', target: 'lib/acme.ts' }] }), (d, o) => {
    mkdirSync(join(d, 'src'))
    symlinkSync(o, join(d, 'src/lib'))
  })
  const r = await refused('message names the item and the path', item({ files: [{ path: 'a.md', type: 'registry:file', target: '~/docs/acme.md' }] }), link('docs'))
  expect(r.text).toContain(URL_ITEM)
  expect(r.text).toContain('docs/acme.md')
})

test('F228: a target or path outside the project is refused (..: encoded or not, absolute, drive, backslash, NUL)', async () => {
  for (const target of ['../escape.ts', '~/../escape.ts', '/etc/passwd', 'C:/x.ts', 'a\\b.ts', 'a/../../b.ts', '%2e%2e/x.ts', 'a\0b.ts', '@ui/../x.ts']) {
    await refused(`target ${JSON.stringify(target)}`, item({ files: [{ path: 'a.ts', type: 'registry:file', target }] }))
  }
  await refused('path with ..', item({ files: [{ path: 'registry/../../x.tsx', type: 'registry:ui' }] }))
})

test('F228: what else the CLI writes is checked: the CSS entry (cssVars/css) and env files (envVars)', async () => {
  await refused('cssVars through a linked css entry', item({ cssVars: { theme: { x: '1' } } }), (d, o) => {
    rmSync(join(d, 'app.css'))
    const real = join(outsideDir(), 'real.css') // the link's target lives elsewhere: `o` must stay empty
    writeFileSync(real, '@import "tailwindcss";\n@import "shadcn/tailwind.css";\n') // the theme step is skipped: only the item's cssVars write the entry
    symlinkSync(real, join(d, 'app.css'))
  })
  await refused('envVars through a linked .env.local', item({ envVars: { KEY: 'v' } }), (d, o) => symlinkSync(join(o, 'env'), join(d, '.env.local')))
})

test('F228: an item we cannot judge is refused: not JSON, not an object, bad files, a config, a dependency URL or namespaced dependency', async () => {
  await refused('not JSON', '<html>nope</html>')
  await refused('array', '[]')
  await refused('files not an array', item({ files: {} }))
  await refused('file entry not an object', item({ files: [3] }))
  await refused('target not a string', item({ files: [{ path: 'a', target: 3 }] }))
  const cfg = await refused('config', item({ config: { aliases: { ui: '@/x' } } }))
  expect(cfg.text).toContain('config')
  const dep = await refused('dependency URL', item({ registryDependencies: ['https://other.dev/r/x.json'] }))
  expect(dep.text).toContain('as its own argument')
  await refused('namespaced dependency', item({ registryDependencies: ['@acme/button'] }))
  await refused('extends a URL', item({ extends: 'https://other.dev/r/x.json' }))
  // a plain-name dependency (the default registry) is fine
  expect((await init(project(), item({ registryDependencies: ['button', 'utils'] }))).code).toBe(0)
})

// Mellow F2: vetItem was a denylist of keys. A `registry:font` item makes the CLI write the CSS entry (and, on a next app,
// a layout file) through keys it did not name. Now only the keys of the pinned schema pass.
test('F228: a font item and a key the check does not know are refused (allowlist), as is a registry:page', async () => {
  const font = await refused('font item', item({ type: 'registry:font', name: 'inter', font: { family: "'Inter'", provider: 'google', import: 'Inter', variable: '--font-sans' } }))
  expect(font.text).toContain('registry:font')
  const key = await refused('font key', item({ name: 'x', font: { family: 'x' } }))
  expect(key.text).toContain('"font"')
  await refused('unknown key', item({ name: 'x', somethingNew: true }))
  await refused('config key', item({ config: { aliases: { ui: '@/x' } } }))
  await refused('registry:page', item({ type: 'registry:page', files: [{ path: 'a.tsx', type: 'registry:page', target: '~/a.tsx' }] }))
  await refused('type not a string', item({ type: 3 }))
  // every key of the schema is accepted when it is sound
  expect((await init(project(), item({ $schema: 'x', name: 'x', type: 'registry:ui', title: 't', author: 'a', description: 'd', dependencies: ['x'], devDependencies: ['y'], registryDependencies: ['button'], files: [], meta: {}, docs: 'd', categories: ['c'] }))).code).toBe(0)
})

test('F228: a network or HTTP error refuses with the reason; nothing is spawned or written', async () => {
  const r = await refused('network', new Error('connection refused'))
  expect(r.text).toContain('connection refused')
  expect(r.text).toContain(URL_ITEM)
})

test('F228: vetItem lists the paths to check, and passes an item with only alias-relative targets', () => {
  const v = vetItem(item({ files: [{ path: 'x', type: 'registry:ui', target: '@ui/sub/x.tsx' }, { path: 'y', target: '@weird/y.ts' }] }), 'app.css')
  expect('paths' in v && v.paths).toContain('weird/y.ts')
  expect('paths' in v && v.paths.some((p) => p.includes('sub/x'))).toBe(false) // inside an alias directory: scanned already
})

// --- fetchRegistryItem against a local http server (the `schemes` option stands in for https) ---

const HTTP = { schemes: ['http:'] }
function serve(handler: (req: Request) => Response | Promise<Response>): { url: string; stop: () => void } {
  const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: handler })
  return { url: `http://127.0.0.1:${s.port}`, stop: () => void s.stop(true) }
}

test('F228 fetch: https only by default; a body within the cap is returned', async () => {
  const s = serve(() => new Response('{"ok":1}'))
  try {
    expect(await fetchRegistryItem(`${s.url}/a.json`, HTTP)).toBe('{"ok":1}')
    await expect(fetchRegistryItem(`${s.url}/a.json`)).rejects.toThrow(/not an https URL/)
    await expect(fetchRegistryItem('ftp://x.dev/a.json')).rejects.toThrow(/not an https URL/)
    await expect(fetchRegistryItem('https://user:pw@x.dev/a.json')).rejects.toThrow(/credentials/)
  } finally {
    s.stop()
  }
})

test('F228 fetch: a body over the cap is refused (declared length, and a streamed body with none)', async () => {
  const big = 'x'.repeat(2000)
  const s = serve((req) => {
    const stream = new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode(big)), c.close()) })
    return new URL(req.url).pathname === '/stream' ? new Response(stream) : new Response(big)
  })
  try {
    await expect(fetchRegistryItem(`${s.url}/declared`, { ...HTTP, maxBytes: 1000 })).rejects.toThrow(/limit/)
    await expect(fetchRegistryItem(`${s.url}/stream`, { ...HTTP, maxBytes: 1000 })).rejects.toThrow(/limit/)
    expect(await fetchRegistryItem(`${s.url}/declared`, { ...HTTP, maxBytes: 5000 })).toBe(big)
    expect(ITEM_MAX_BYTES).toBe(1024 * 1024)
  } finally {
    s.stop()
  }
})

test('F228 fetch: a redirect to a non-https URL is refused, redirects are bounded, an HTTP error is named', async () => {
  const s = serve((req) => {
    const p = new URL(req.url).pathname
    if (p === '/to-https') return new Response(null, { status: 302, headers: { location: 'https://elsewhere.invalid/a.json' } })
    if (p === '/to-ftp') return new Response(null, { status: 302, headers: { location: 'ftp://x.dev/a.json' } })
    if (p === '/loop') return new Response(null, { status: 302, headers: { location: '/loop' } })
    if (p === '/no-location') return new Response(null, { status: 302 })
    if (p === '/one') return new Response(null, { status: 302, headers: { location: '/final' } })
    if (p === '/final') return new Response('{"final":true}')
    return new Response('nope', { status: 404 })
  })
  try {
    // (`schemes: ['http:']` stands for "https only": a redirect to anything else is refused the same way)
    await expect(fetchRegistryItem(`${s.url}/to-https`, HTTP)).rejects.toThrow(/not an http URL/)
    await expect(fetchRegistryItem(`${s.url}/to-ftp`, HTTP)).rejects.toThrow(/not an http URL/)
    await expect(fetchRegistryItem(`${s.url}/loop`, HTTP)).rejects.toThrow(/redirects more than/)
    await expect(fetchRegistryItem(`${s.url}/no-location`, HTTP)).rejects.toThrow(/no Location/)
    await expect(fetchRegistryItem(`${s.url}/missing`, HTTP)).rejects.toThrow(/HTTP 404/)
    expect(await fetchRegistryItem(`${s.url}/one`, HTTP)).toBe('{"final":true}') // a redirect that stays allowed is followed
  } finally {
    s.stop()
  }
})

test('F228 fetch: a server that does not answer is given up on after the timeout', async () => {
  const s = serve(() => new Promise<Response>(() => {})) // never answers
  try {
    const t0 = performance.now()
    await expect(fetchRegistryItem(`${s.url}/hang.json`, { ...HTTP, timeoutMs: 300 })).rejects.toThrow(/did not answer within/)
    expect(performance.now() - t0).toBeLessThan(5000)
  } finally {
    s.stop()
  }
})
