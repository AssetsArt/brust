// (run a copy from tests/server/ so `playwright` resolves: cp serve.ts tests/server/zz-sod-serve.ts)
// usage: WT=<worktree> APP=<app dir under WT> bun serve.ts <page>...   (BRUST_SPIKE_B=1 for the option-B spike)
// Builds APP with WT's brust, serves it, and for each page compares, after every click on [data-testid=f] and on
// [data-testid=box], the page's observable state (text, data-* and checked of every element under <main>) with React
// hydrating the same page in the same browser. Prints one line per page: equal or the first difference.
import { join } from 'node:path'
import { chromium, type Page } from 'playwright'
const wt = process.env.WT!, app = join(wt, process.env.APP!), bin = join(wt, 'packages/brust/bin/brust')
const b = Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
if (b.exitCode !== 0) throw new Error(b.stderr.toString())
const manifest = JSON.parse(await Bun.file(join(app, 'dist/manifest.json')).text()) as { components: Record<string, { tier: string }> }
const r = await Bun.build({ entrypoints: [join(app, 'react-entry.tsx')], target: 'browser', define: { 'process.env.NODE_ENV': '"production"' } })
const reactJs = await r.outputs[0]!.text()
const { renderPage } = await import(join(app, 'render.ts'))
process.on('exit', () => proc?.kill())
const proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '1'], { cwd: app, env: { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '' }, stdout: 'pipe', stderr: 'inherit' })
const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader(); let out = ''
while (!/\[brust\] ready/.test(out)) { const { value, done } = await reader.read(); if (done) throw new Error(out); out += new TextDecoder().decode(value) }
const base = `http://${/listening on (\S+)/.exec(out)![1]}`
const browser = await chromium.launch()
const state = (p: Page) => p.evaluate(() => [...document.querySelectorAll('main *')].map((e) => `${e.localName}${[...e.attributes].filter((a) => a.name.startsWith('data-')).map((a) => `[${a.name}=${a.value}]`).join('')}${(e as HTMLInputElement).checked ? '[checked]' : ''}:${e.children.length ? '' : e.textContent}`).join(' '))
async function run(page: string, react: boolean) {
  const p = await browser.newPage(); const warns: string[] = []
  p.on('console', (m) => (m.type() === 'warning' || m.type() === 'error') && warns.push(m.text()))
  if (react) {
    await p.route('http://react.test/**', (rt) => rt.request().url().endsWith('/app.js') ? rt.fulfill({ contentType: 'text/javascript', body: reactJs }) : rt.fulfill({ contentType: 'text/html', body: `<!doctype html><body><div id="root">${renderPage(page)}</div><script>window.__page=${JSON.stringify(page)}</script><script src="/app.js"></script>` }))
    await p.goto('http://react.test/'); await p.waitForFunction(() => (window as any).__hydrated)
  } else await p.goto(`${base}/${page}`)
  await p.waitForTimeout(300)
  const log = [await state(p)]
  for (const t of ['f', 'box', 'f', 'box', 'f']) { if (!(await p.$(`[data-testid="${t}"]`))) continue; try { await p.click(`[data-testid="${t}"]`, { timeout: 3000 }) } catch (e) { log.push(`click ${t} failed: ${String(e).split('\n')[0]}`); break } await p.waitForTimeout(80); log.push(await state(p)) }
  await p.close(); return { log, warns }
}
for (const page of process.argv.slice(2)) {
  const [re, br] = [await run(page, true), await run(page, false)]
  const diff = re.log.findIndex((s, i) => s !== br.log[i])
  const tier = Object.entries(manifest.components).filter(([k]) => k.startsWith('p') && !k.startsWith('pr')).map(([k, v]) => `${k.split('_')[0]}:${v.tier}`).join(',')
  console.log(`${page}: ${diff < 0 ? 'EQUAL' : `DIFF at step ${diff}: react=${re.log[diff]} | brust=${br.log[diff]}`} warns=${JSON.stringify(br.warns)} final=${br.log.at(-1)}`)
}
console.log('tiers', Object.entries(manifest.components).map(([k, v]) => `${k}:${v.tier}`).join(' '))
await browser.close(); proc.kill('SIGINT'); await proc.exited
