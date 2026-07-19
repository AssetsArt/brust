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
  const page = harness.read('pages/HelloWorld.tsx')
  const invalidCursor = harness.cursor()
  harness.write('routes.tsx', `${routes}\nexport const reliabilityBroken = @@@\n`)

  await harness.waitForTypes(['building', 'error'], invalidCursor)
  await harness.waitForNoTypes(['reload', 'ok'], invalidCursor)
  expect(await harness.fetchText('/ping')).toBeTruthy()
  expect(await harness.waitForText('/', 'Hello from Brust')).toContain('Hello from Brust')

  const marker = `reliability-recovery-${Date.now()}`
  const repairCursor = harness.cursor()
  harness.write('routes.tsx', routes)
  await new Promise((resolve) => setTimeout(resolve, 10))
  harness.write(
    'pages/HelloWorld.tsx',
    page.replace('Hello from Brust', `Hello from Brust ${marker}`),
  )
  await harness.waitForTypes(['building', 'reload', 'ok'], repairCursor)
  expect(await harness.waitForText('/', marker)).toContain(marker)
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
  const appCss = `${harness.read('app.css')}\n.${marker} { color: red; }\n`
  harness.write(pagePath, page.replace('Hello from Brust', `Hello from Brust ${marker}`))
  await new Promise((resolve) => setTimeout(resolve, 10))
  harness.write('app.css', appCss)
  await new Promise((resolve) => setTimeout(resolve, 10))
  harness.write(modulePath, `.probe { --reliability-component: ${marker}; }\n`)
  await new Promise((resolve) => setTimeout(resolve, 10))
  // macOS may coalesce one filesystem notification under parallel process
  // load; a same-window rewrite keeps the semantic input identical while
  // ensuring the app-css path reaches the watcher callback.
  harness.write('app.css', `${appCss}/* ${marker} */\n`)

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

test('an island edit refreshes both the emitted and served client chunk', async () => {
  harness = await HotReloadHarness.create()
  await harness.start(2)

  const marker = `reliability-island-${Date.now()}`
  const cursor = harness.cursor()
  const counter = harness.read('components/Counter.tsx')
  harness.write(
    'components/Counter.tsx',
    counter.replace(
      '      {label}: {n}\n    </button>',
      `      {label}: {n} ${marker}\n    </button>`,
    ),
  )

  await harness.waitForTypes(['building', 'reload', 'ok'], cursor)
  const chunkName = readdirSync(harness.path('.brust/islands')).find(
    (name) => name.startsWith('Counter_') && name.endsWith('.js'),
  )
  expect(chunkName).toBeTruthy()
  expect(harness.read(`.brust/islands/${chunkName}`)).toContain(marker)
  expect(await harness.fetchText(`/_brust/islands/${chunkName}`)).toContain(marker)
}, 60000)
