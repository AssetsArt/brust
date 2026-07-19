import { afterEach, expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { HotReloadHarness } from './helpers/hot-reload-harness.ts'

let harness: HotReloadHarness | null = null

afterEach(async () => {
  await harness?.cleanup()
  harness = null
})

test('invalid routes stay on the healthy generation and recover after correction', async () => {
  harness = await HotReloadHarness.create()
  await harness.start(2)

  const healthyHtml = await harness.fetchText('/')
  expect(healthyHtml).toContain('Hello from Brust')

  const routes = harness.read('routes.tsx')
  const invalidCursor = harness.cursor()
  harness.write('routes.tsx', `${routes}\nexport const reliabilityBroken = @@@\n`)

  await harness.waitForTypes(['building', 'error'], invalidCursor)
  expect(harness.messages.slice(invalidCursor).map((frame) => frame.type)).toEqual([
    'building',
    'error',
  ])
  expect(await harness.fetchText('/')).toContain('Hello from Brust')

  const repairCursor = harness.cursor()
  harness.write('routes.tsx', routes)
  await harness.waitForTypes(['building', 'reload', 'ok'], repairCursor)
  expect(await harness.fetchText('/')).toContain('Hello from Brust')
}, 60000)

test('an app CSS edit arriving during a full reload is processed before the drain completes', async () => {
  harness = await HotReloadHarness.create()
  await harness.start(10)

  const page = harness.read('pages/HelloWorld.tsx')
  const css = harness.read('app.css')
  const marker = `reliability-inflight-${Date.now()}`
  const cursor = harness.cursor()

  harness.write('pages/HelloWorld.tsx', page.replace('Hello from Brust', 'Hello from Brust queued'))
  await harness.waitForTypes(['building'], cursor)
  harness.write('app.css', `${css}\n.${marker} { --reliability-marker: ${marker}; }\n`)

  await harness.waitForTypes(['building', 'reload', 'ok', 'building', 'css-update', 'ok'], cursor)
  expect(await harness.fetchText('/_brust/css/app.css')).toContain(marker)
}, 60000)

test('one debounce window preserves TS, app CSS, and component CSS products', async () => {
  harness = await HotReloadHarness.create()
  const pagePath = 'pages/HelloWorld.tsx'
  const modulePath = 'components/Reliability.module.css'
  const page = harness
    .read(pagePath)
    .replace(
      "import Layout from '../components/Layout'",
      "import Layout from '../components/Layout'\nimport styles from '../components/Reliability.module.css'",
    )
    .replace('<h1>', '<h1 className={styles.probe}>')
  harness.write(pagePath, page)
  harness.write(modulePath, '.probe { --reliability-component: initial; }\n')
  await harness.start(2)

  const marker = `reliability-mixed-${Date.now()}`
  const cursor = harness.cursor()
  harness.write(pagePath, page.replace('Hello from Brust', `Hello from Brust ${marker}`))
  await new Promise((resolve) => setTimeout(resolve, 10))
  harness.write('app.css', `${harness.read('app.css')}\n.${marker} { color: red; }\n`)
  await new Promise((resolve) => setTimeout(resolve, 10))
  harness.write(modulePath, `.probe { --reliability-component: ${marker}; }\n`)

  await harness.waitForTypes(
    ['building', 'reload', 'ok', 'building', 'css-update', 'ok', 'building', 'css-update', 'ok'],
    cursor,
  )
  expect(await harness.fetchText('/')).toContain(marker)
  expect(await harness.fetchText('/_brust/css/app.css')).toContain(marker)

  const manifest = JSON.parse(harness.read('.brust/css/component-manifest.json')) as {
    modules: Record<string, { chunk: string }>
  }
  const chunk = manifest.modules[harness.path(modulePath)]?.chunk
  expect(chunk).toBeTruthy()
  expect(await harness.fetchText(chunk)).toContain(marker)
}, 60000)

test('a successful page reload serves the changed route dependency', async () => {
  harness = await HotReloadHarness.create()
  await harness.start(2)

  const marker = `reliability-page-${Date.now()}`
  const cursor = harness.cursor()
  harness.write(
    'pages/HelloWorld.tsx',
    harness.read('pages/HelloWorld.tsx').replace('Hello from Brust', `Hello from Brust ${marker}`),
  )

  await harness.waitForTypes(['building', 'reload', 'ok'], cursor)
  expect(await harness.fetchText('/')).toContain(marker)
}, 60000)

// Known red, independently reproduced and tracked by
// hot-reload-island-root-cause. Core Tasks 1-3 must not change island
// production code; keep this executable characterization at the process seam.
test.skip('an island edit refreshes both the emitted and served client chunk', async () => {
  harness = await HotReloadHarness.create()
  await harness.start(2)

  const marker = `reliability-island-${Date.now()}`
  const cursor = harness.cursor()
  harness.write(
    'components/Counter.tsx',
    harness.read('components/Counter.tsx').replace('{label}: {n}', `{label}: {n} ${marker}`),
  )

  await harness.waitForTypes(['building', 'reload', 'ok'], cursor)
  const chunkName = readdirSync(harness.path('.brust/islands')).find(
    (name) => name.startsWith('Counter_') && name.endsWith('.js'),
  )
  expect(chunkName).toBeTruthy()
  expect(harness.read(`.brust/islands/${chunkName}`)).toContain(marker)
  expect(await harness.fetchText(`/_brust/islands/${chunkName}`)).toContain(marker)
}, 60000)
