// Migrating from 0.1.x — package and import renames, CLI, removed features, config, the actions client; the demo
// switches the pokedex's routes between 0.1.x and 2.x.
import CodeBlock from '../../components/CodeBlock'
import Note from '../../components/docs/Note'
import SwitchPanels from '../../components/demos/SwitchPanels'
import { type CodeBlockData, codeBlock } from '../../lib/highlight'
import type { TocItem } from '../../lib/nav'

export interface MigratingData {
  toc: TocItem[]
  blocks: Record<'install', CodeBlockData>
  panels: { id: string; tab: string; note: string; text: string }[]
}

const OLD = `import { defineRoutes } from 'brustjs/routes'
import AppLayout from './components/AppLayout'
import { browseLoader, detailLoader, homeLoader } from './lib/loaders'
import BrowsePage from './pages/BrowsePage'
import DetailPage from './pages/DetailPage'
import HomePage from './pages/HomePage'

export const routes = defineRoutes([
  {
    Component: AppLayout,
    native: true,
    children: [
      { path: '/', Component: HomePage, native: true, loader: homeLoader },
      { path: '/pokedex', Component: BrowsePage, native: true, loader: browseLoader },
      { path: '/pokemon/{name}', Component: DetailPage, native: true, loader: detailLoader },
    ],
  },
])`

const NEW = `import { defineRoutes } from '@brust/core/routes'
import AppLayout from './components/AppLayout'
import { browseLoader, detailLoader, homeLoader } from './lib/loaders'
import BrowsePage from './pages/BrowsePage'
import DetailPage from './pages/DetailPage'
import HomePage from './pages/HomePage'

export const routes = defineRoutes([
  {
    Component: AppLayout,
    children: [
      { path: '/', Component: HomePage, loader: homeLoader },
      { path: '/pokedex', Component: BrowsePage, loader: browseLoader },
      { path: '/pokemon/{name}', Component: DetailPage, loader: detailLoader },
    ],
  },
])`

export async function migratingLoader(): Promise<MigratingData> {
  return {
    toc: [
      { id: 'packages', title: 'Packages and imports' },
      { id: 'routes', title: 'Routes' },
      { id: 'cli', title: 'CLI' },
      { id: 'gone', title: 'What is gone' },
      { id: 'config', title: 'brust.toml' },
      { id: 'client', title: 'The actions client' },
    ],
    blocks: { install: codeBlock({ lang: 'sh', cwd: '~/pokedex', code: '$ bun remove brustjs\n$ bun add @brust/core' }) },
    panels: [
      { id: 'old', tab: '0.1.x', note: 'The pokedex example on 0.1.x (branch main): every route opts in with native: true.', text: OLD },
      { id: 'new', tab: '2.x', note: 'The same routes on 2.x: the compiler decides per component, so native: true is gone (and now fails the build).', text: NEW },
    ],
  }
}

export default function Migrating({ blocks, panels }: MigratingData) {
  return (
    <>
      <h1>Migrating from 0.1.x</h1>
      <p className="lead">brust 2 is a rewrite. 0.1.x lives on the main branch as brustjs; 2.x is @brust/core. Most app code moves over with renamed imports and fewer route fields.</p>

      <h2 id="packages">Packages and imports</h2>
      <CodeBlock code={blocks.install.code} lang={blocks.install.lang} cwd={blocks.install.cwd} html={blocks.install.html} />
      <table>
        <thead>
          <tr>
            <th>0.1.x</th>
            <th>2.x</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>brustjs</code> (binary <code>brustjs</code>)
            </td>
            <td>
              <code>@brust/core</code> (binary <code>brust</code>)
            </td>
          </tr>
          <tr>
            <td>
              <code>brustjs/routes</code>
            </td>
            <td>
              <code>@brust/core/routes</code>
            </td>
          </tr>
          <tr>
            <td>
              <code>brustjs/store</code>
            </td>
            <td>
              <code>@brust/core/store</code>, and <code>@brust/core/store/react</code> for <code>useStore</code>
            </td>
          </tr>
          <tr>
            <td>
              <code>brustjs/client</code>
            </td>
            <td>
              <code>@brust/core/client</code> (the Eden actions client)
            </td>
          </tr>
        </tbody>
      </table>

      <h2 id="routes">Routes</h2>
      <p>A route has exactly five fields now: path, Component, loader, cache, children. Switch between the two versions of the pokedex's routes:</p>
      <div className="browser">
        <div className="url">
          <span>routes.tsx</span>
          <span className="lbl">SwitchPanels · native</span>
        </div>
        <div className="vp">
          <SwitchPanels label="Version" panels={panels} />
        </div>
      </div>
      <p>
        Also rejected now: <code>errorBoundary</code>, <code>ssg</code>, <code>middleware</code>, <code>sse</code>, <code>websocket</code>, <code>cache.key</code> and <code>cache.key_ttl_seconds</code>.
      </p>

      <h2 id="cli">CLI</h2>
      <ul>
        <li>
          <code>brustjs new</code> is now <code>bun create @brust/app</code>.
        </li>
        <li>
          <code>brustjs dev</code> (watch and reload) has no Bun equivalent: <code>brust dev</code> is the Cloudflare loop. Use <code>bun run dev</code> to build and start.
        </li>
        <li>
          <code>--target</code> now means <code>bun</code> or <code>cloudflare</code>, not a native binary platform. <code>--ssg</code> is gone.
        </li>
      </ul>

      <h2 id="gone">What is gone</h2>
      <ul>
        <li>
          <code>native: true</code> routes and hand-written <code>x-*</code> behaviors: every component is compiled, and <code>x-*</code> attributes are now compiler output.
        </li>
        <li>
          Markdown pages (<code>mdRoutes</code>, <code>mdNav</code>) and static generation.
        </li>
        <li>
          The <code>window.Brust</code> AI runtime.
        </li>
      </ul>

      <h2 id="config">brust.toml</h2>
      <ul>
        <li>
          <code>[cache] max_entries</code> and <code>page_max_entries</code> are unknown keys now: <code>[cache]</code> configures a cache adapter.
        </li>
        <li>
          <code>BRUST_AI</code>, <code>BRUST_CACHE_SYNC_URL</code> and <code>BRUST_CACHE_SYNC_CHANNEL</code> are gone. <code>BRUST_ADDR</code>, <code>BRUST_PORT</code> and <code>BRUST_WORKERS</code> mean what they meant.
        </li>
      </ul>

      <h2 id="client">The actions client</h2>
      <p>The 0.1.x client was hand-made; the 2.x one is Eden Treaty, and its behavior is not shimmed back:</p>
      <ul>
        <li>A network failure resolves with status 503, not 0.</li>
        <li>
          <code>headers</code> is a <code>Headers</code> object, not a plain record.
        </li>
        <li>
          Path params are <code>encodeURIComponent</code>-ed: <code>item({'({ id: "a b/c" })'})</code> requests <code>/item/a%20b%2Fc</code>.
        </li>
      </ul>
      <Note>
        Cross-site action requests are rejected by default in 2.x (<code>cross_site = "reject"</code>). Set it to <code>"allow"</code> only if another site must call your actions.
      </Note>
    </>
  )
}
