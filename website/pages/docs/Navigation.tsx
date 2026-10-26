// Navigation — links swap the page in place, the one rule, what is swapped, opt-outs, prefetch and the page cache, the brust:nav:* events, the progress
// bar, page transitions, navigate(), the navigation store.
// Source of truth: docs/navigation.md and the SPA navigation design. This page is static: the docs site you are reading navigates this way.
import CodeBlock from '../../components/CodeBlock'
import Lead from '../../components/docs/Lead'
import Note from '../../components/docs/Note'
import { type CodeBlockData, codeBlock } from '../../lib/highlight'
import type { TocItem } from '../../lib/nav'

export interface NavigationData {
  toc: TocItem[]
  blocks: Record<'tag' | 'line' | 'lineCss' | 'bar' | 'barCss' | 'spinner' | 'go' | 'persist' | 'clear' | 'color' | 'vt', CodeBlockData>
}

const TAG = `<script type="module" src="/_brust/client/nav-3f9c1a07b2.js"
  data-brust-nav data-brust-build="9a41c0e7" data-brust-root="root:5b1d0c33"></script>`

const BAR = `document.addEventListener('brust:nav:load', () => bar.start())
document.addEventListener('brust:nav:success', () => bar.done())
document.addEventListener('brust:nav:error', (e) => {
  bar.done()
  if (!e.detail.swapped) report(e.detail.error)
})`

const LINE = `import { navigation } from '@brust/core/navigation'
import { useStore } from '@brust/core/store/react'

export default function LoadingLine() {
  const nav = useStore(navigation)
  return <div className="line" data-state={nav.state} />
}`

const LINE_CSS = `.line { transform: scaleX(0); transform-origin: left; }
.line[data-state="loading"] {
  transform: scaleX(.8);
  transition: transform 8s cubic-bezier(.1, .8, .2, 1) .15s;
}`

const BAR_CSS = `.bar { transform: scaleX(0); transform-origin: left; }
html[data-brust-loading] .bar {
  transform: scaleX(.8);
  transition: transform 8s cubic-bezier(.1, .8, .2, 1) .15s;
}`

const SPINNER = `import { navigation } from '@brust/core/navigation'
import { useStore } from '@brust/core/store/react'

export default function NavSpinner() {
  const nav = useStore(navigation)
  return <div hidden={nav.state !== 'loading'}>Loading {nav.to}…</div>
}`

const GO = `import { navigate } from '@brust/core'

navigate('/docs/store')                                // push an entry
await navigate('/search?q=brust', { replace: true })   // replace the current one`

const PERSIST = `<audio data-brust-persist="player" src="/public/live.mp3" controls></audio>`

const CLEAR = `import { clearNavigationCache } from '@brust/core'

await fetch('/api/cart', { method: 'POST', body })
clearNavigationCache()`

const COLOR = `:root { --brust-progress-color: var(--accent); }`

const VT = `::view-transition-old(root),
::view-transition-new(root) { animation-duration: 150ms; }`

export async function navigationLoader(): Promise<NavigationData> {
  return {
    toc: [
      { id: 'rule', title: 'The one rule' },
      { id: 'swap', title: 'What is swapped' },
      { id: 'clicks', title: 'Which clicks navigate' },
      { id: 'opt-outs', title: 'Opt-outs' },
      { id: 'prefetch', title: 'Prefetch and the cache' },
      { id: 'events', title: 'Events' },
      { id: 'progress', title: 'The progress bar' },
      { id: 'transitions', title: 'Page transitions' },
      { id: 'navigate', title: 'navigate()' },
      { id: 'navigation-store', title: 'The navigation store' },
      { id: 'stores', title: 'Stores and islands' },
    ],
    blocks: {
      tag: codeBlock({ lang: 'text', file: 'view-source', code: TAG }),
      line: codeBlock({ lang: 'tsx', file: 'LoadingLine.tsx', code: LINE }),
      lineCss: codeBlock({ lang: 'text', file: 'app.css', code: LINE_CSS }),
      bar: codeBlock({ lang: 'ts', file: 'bar.ts', code: BAR }),
      barCss: codeBlock({ lang: 'text', file: 'app.css', code: BAR_CSS }),
      spinner: codeBlock({ lang: 'tsx', file: 'NavSpinner.tsx', code: SPINNER }),
      go: codeBlock({ lang: 'ts', file: 'Search.tsx', code: GO }),
      persist: codeBlock({ lang: 'text', file: 'Layout.tsx', code: PERSIST }),
      clear: codeBlock({ lang: 'ts', file: 'cart.ts', code: CLEAR }),
      color: codeBlock({ lang: 'text', file: 'app.css', code: COLOR }),
      vt: codeBlock({ lang: 'text', file: 'app.css', code: VT }),
    },
  }
}

export default function Navigation({ blocks }: NavigationData) {
  return (
    <>
      <h1>Navigation</h1>
      <Lead>A link click does not reload the page. brust fetches the real HTML of the target and swaps it in place, so the page is the one a full load would show. You write nothing for it.</Lead>
      <p>
        Every full document carries a small <code>nav</code> script, also a page that is all static and loads no runtime, and the output of <code>brust build --target static</code> too. A page that cannot be swapped is loaded the normal way, so a link
        always works.
      </p>
      <CodeBlock code={blocks.tag.code} lang={blocks.tag.lang} file={blocks.tag.file} html={blocks.tag.html} />

      <h2 id="rule">The one rule</h2>
      <p>
        A navigation shows exactly what a full load of that URL would show. Only JavaScript state that lives outside the page survives: live stores, module-level state, and elements you marked <code>data-brust-persist</code>. When you are unsure what
        a navigation does, ask what a full load would do.
      </p>

      <h2 id="swap">What is swapped</h2>
      <ul>
        <li>
          <b>The head</b> becomes the new document's head children, in the new order: title, meta, canonical, stylesheets, inline styles, JSON-LD. An identical element is reused, so a stylesheet both pages share is not downloaded or flashed again.
          New stylesheets and every module script of the new page are loaded before the swap, so the page never paints unstyled and a feature the first page did not use is there when its component mounts. A head element that a live component added at
          runtime, such as a CSS-in-JS <code>&lt;style&gt;</code>, is kept.
        </li>
        <li>
          <b>The body</b>: only the layout levels that changed are replaced. A nested layout whose own markup is the same in both pages stays live, with its DOM, component state, hydrated islands and inner scroll positions. When the root layout changes,
          the whole body is replaced, and the attributes of <code>&lt;html&gt;</code> and <code>&lt;body&gt;</code> follow the new page.
        </li>
        <li>
          <b>Scroll</b>: the new page scrolls to its <code>#hash</code> target or to the top. Back and forward restore the position the entry had. A link to the URL already on screen loads it again, from the page cache while it is fresh, without a new history entry.
        </li>
      </ul>

      <h2 id="clicks">Which clicks navigate</h2>
      <p>
        A plain primary-button click on an <code>&lt;a href&gt;</code> to the same origin. These are left to the browser: a click with Ctrl, Meta, Shift or Alt, a link with a <code>target</code> other than <code>_self</code> or with{' '}
        <code>download</code>, a click that something already <code>preventDefault()</code>-ed, and a link that only changes the <code>#hash</code> of the current page. A <code>&lt;form&gt;</code> is not intercepted: it submits as before.
      </p>

      <h2 id="opt-outs">Opt-outs</h2>
      <table>
        <thead>
          <tr>
            <th>Attribute</th>
            <th>Effect</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>data-brust-reload</code>
            </td>
            <td>
              On a link, a region, <code>&lt;html&gt;</code> or <code>&lt;body&gt;</code>: the links inside get a normal full load and are not prefetched. On <code>&lt;html&gt;</code> it turns SPA navigation off for the whole app.
            </td>
          </tr>
          <tr>
            <td>
              <code>data-brust-prefetch="false"</code>
            </td>
            <td>On a link or a region: the links inside are not prefetched. They still navigate.</td>
          </tr>
          <tr>
            <td>
              <code>data-brust-persist="&lt;key&gt;"</code>
            </td>
            <td>
              If the old and the new page both have an element with this key, the live old element is moved into the new page and never disposed: a playing video, an open chat widget.
            </td>
          </tr>
          <tr>
            <td>
              <code>data-brust-once</code>
            </td>
            <td>On a classic <code>&lt;script&gt;</code>: it runs on the first load of the tab only, as an analytics loader should.</td>
          </tr>
          <tr>
            <td>
              <code>data-brust-cache="&lt;seconds&gt;"</code>
            </td>
            <td>On <code>&lt;html&gt;</code>: how long a fetched page stays fresh in the page cache (default 300). <code>0</code> turns the cache off.</td>
          </tr>
          <tr>
            <td>
              <code>data-brust-progress="off"</code>
            </td>
            <td>On <code>&lt;html&gt;</code>: no progress bar.</td>
          </tr>
          <tr>
            <td>
              <code>data-brust-transition="off"</code>
            </td>
            <td>On <code>&lt;html&gt;</code>: no page transition.</td>
          </tr>
        </tbody>
      </table>
      <CodeBlock code={blocks.persist.code} lang={blocks.persist.lang} file={blocks.persist.file} html={blocks.persist.html} />
      <p>
        There is no config key: the attribute is the opt-out. A classic <code>&lt;script&gt;</code> in the head that is new to the page runs. After a whole-body swap, every classic head script runs again in order, as on a full load, which keeps a theme
        script that sets <code>&lt;html class&gt;</code> correct. A script in a layout that was kept does not run again.
      </p>

      <h2 id="prefetch">Prefetch and the page cache</h2>
      <p>
        brust fetches a link's page when you show intent: after 65 ms of hover, on focus, or at once on <code>touchstart</code>. Prefetch is off when the browser asks to save data or is on a <code>2g</code> connection, and for the opt-outs above. A
        prefetch fires no events.
      </p>
      <p>Every fetched page, prefetched or navigated to, goes into a page cache in memory, one per tab:</p>
      <ul>
        <li>
          <b>Fresh for 5 minutes.</b> While a page is fresh, hovering its link again fetches nothing, and a click or <code>navigate()</code> shows it with zero requests. After that it is fetched again.
        </li>
        <li>
          <b>Back and forward</b> show the cached page at any age, as the browser's back-forward cache does. A click during a prefetch waits for that same request.
        </li>
        <li>
          <b>Never cached</b>: a response with <code>Cache-Control: no-store</code>, any status of 400 or more, and a response that is not a brust page of this build. A page that must never be stale sends <code>no-store</code>.
        </li>
        <li>
          <b>Only <code>no-store</code> keeps a page out.</b> <code>private</code>, <code>no-cache</code>, <code>max-age=0</code> and <code>must-revalidate</code> do not: many hosts send <code>public, max-age=0, must-revalidate</code> on every page,
          and such a page is cached for its 5 minutes. A page that must never be shown from memory, such as an authenticated or sensitive one, sends <code>Cache-Control: no-store</code>: a loader sets it with <code>res.headers</code>, and on a layout it covers every page under it (see <a href="/docs/loaders#headers">Response headers</a>). A logout through <code>@brust/core/client</code> already
          clears the cache; any other logout calls <code>clearNavigationCache()</code>.
        </li>
        <li>
          It holds at most 32 pages, the least recently used going first, keyed by the URL without its <code>#hash</code>. <code>&lt;html data-brust-cache="60"&gt;</code> sets the freshness in seconds, and <code>0</code> turns it off.
        </li>
      </ul>
      <p>
        <b>Mutations clear it.</b> A call through <code>@brust/core/client</code> with any method other than <code>GET</code> or <code>HEAD</code> clears the whole cache once it gets a response, so a page read after a mutation is never one from
        before it. If you change data another way, clear it yourself:
      </p>
      <CodeBlock code={blocks.clear.code} lang={blocks.clear.lang} file={blocks.clear.file} html={blocks.clear.html} />
      <p>
        A navigation served from the cache fires the same events. Without a page transition it ends within the same task, so <code>data-brust-loading</code> is never painted. With one, the old page is painted
        once more while it is set, for up to about 100 ms, so an indicator of your own should wait about 150 ms before it shows, as the built-in bar does.
      </p>

      <h2 id="events">Events</h2>
      <p>
        Every event is a <code>CustomEvent</code> on <code>document</code> that bubbles. A native component, a React island and a plain <code>&lt;script&gt;</code> all listen the same way.
      </p>
      <table>
        <thead>
          <tr>
            <th>Event</th>
            <th>When</th>
            <th>
              <code>detail</code>
            </th>
            <th>Cancelable</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>brust:nav:click</code>
            </td>
            <td>A qualifying link click, before anything else.</td>
            <td>
              <code>{'{ id, url, from, link }'}</code>
            </td>
            <td>Yes: <code>preventDefault()</code> leaves the click to the browser.</td>
          </tr>
          <tr>
            <td>
              <code>brust:nav:load</code>
            </td>
            <td>The navigation starts: a link click, <code>navigate()</code> or back/forward.</td>
            <td>
              <code>{'{ id, url, from, trigger }'}</code>
            </td>
            <td>No</td>
          </tr>
          <tr>
            <td>
              <code>brust:nav:success</code>
            </td>
            <td>The new page is in place: swapped, history updated, scrolled and mounting.</td>
            <td>
              <code>{'{ id, url, from, trigger, status }'}</code>
            </td>
            <td>No</td>
          </tr>
          <tr>
            <td>
              <code>brust:nav:error</code>
            </td>
            <td>The navigation did not succeed.</td>
            <td>
              <code>{'{ id, url, from, trigger, status, error, swapped }'}</code>
            </td>
            <td>Yes</td>
          </tr>
        </tbody>
      </table>
      <ul>
        <li>
          <code>trigger</code> is <code>'link'</code>, <code>'navigate'</code> or <code>'popstate'</code>. <code>from</code> is the URL that was on screen, <code>url</code> the final URL after redirects, and <code>id</code> a per-tab counter that pairs
          the end of a navigation with its start.
        </li>
        <li>
          The order is <code>click</code> (link clicks only), <code>load</code>, then exactly one of <code>success</code> or <code>error</code>. A newer navigation supersedes the one in flight, and the superseded one fires nothing more. Its
          request still finishes and goes into the page cache.
        </li>
        <li>
          <code>success</code> fires when the new page is in the DOM, not when a page transition finishes animating.
        </li>
        <li>
          <code>error</code> has two cases. If the server answered with a brust page and a status of 400 or more, such as a <code>notFound()</code> 404, that page is swapped in as a full load would show it: <code>swapped</code> is{' '}
          <code>true</code> and there is no default action. If nothing could be swapped, such as a network failure, a response that is not a brust page of this build or a failed module import, <code>swapped</code> is <code>false</code>,{' '}
          <code>error</code> holds the cause and the default action is a full load of <code>url</code>. <code>preventDefault()</code> cancels that full load, so you can show your own message.
        </li>
        <li>
          Only a response from the same build is swapped. After a deploy, the first navigation does a full load and picks up the new runtime.
        </li>
      </ul>
      <p>
        While a navigation loads, <code>&lt;html&gt;</code> carries <code>data-brust-loading</code>: set at <code>load</code>, removed at <code>success</code> or <code>error</code>.
      </p>

      <h2 id="progress">The progress bar</h2>
      <p>
        A thin line along the top of the viewport while the next page loads. It appears only when a navigation is still loading 150 ms after <code>load</code>, so a cached page or a fast server never shows it. It moves on its own toward about 90%,
        runs to the end at <code>success</code> or <code>error</code>, and fades out. With <code>prefers-reduced-motion: reduce</code> it shows without the movement or the fade. Set its colour with <code>--brust-progress-color</code>:
      </p>
      <CodeBlock code={blocks.color.code} lang={blocks.color.lang} file={blocks.color.file} html={blocks.color.html} />
      <p>
        To build your own indicator, set <code>data-brust-progress="off"</code> on <code>&lt;html&gt;</code> and read the <a href="#navigation-store">navigation store</a> in a component, with no <code>addEventListener</code>. This site's loading
        line is made this way:
      </p>
      <CodeBlock code={blocks.line.code} lang={blocks.line.lang} file={blocks.line.file} html={blocks.line.html} />
      <CodeBlock code={blocks.lineCss.code} lang={blocks.lineCss.lang} file={blocks.lineCss.file} html={blocks.lineCss.html} />
      <p>
        Put it in the layout. It reads <code>state</code>, which is <code>idle</code> in every page's server markup, so the layout renders the same on each page and is kept across navigations. The <code>.15s</code> delay keeps the line still on a
        navigation that is quick, such as one served from the cache.
      </p>
      <p>The store is fed by the four events above. With no component to put a store in, a plain script can listen to them directly:</p>
      <CodeBlock code={blocks.bar.code} lang={blocks.bar.lang} file={blocks.bar.file} html={blocks.bar.html} />
      <p>Or CSS alone, with no JavaScript and no component:</p>
      <CodeBlock code={blocks.barCss.code} lang={blocks.barCss.lang} file={blocks.barCss.file} html={blocks.barCss.html} />

      <h2 id="transitions">Page transitions</h2>
      <p>
        When the browser has the View Transitions API, the swap runs inside a view transition: the browser's own cross-fade of the whole page, opacity only, about 250 ms. Pixels that are the same in both pages, such as a header or sidebar that
        stays, do not visibly change, so only the content that changed fades. Nothing slides or scales.
      </p>
      <ul>
        <li>Everything slow happens first: the fetch, the new page's scripts and stylesheets. The old page is frozen for about one frame, never for a network wait.</li>
        <li>
          The eager images of the new page get up to 100 ms to decode before the fade starts, so a hero image does not pop in after it. Mark images below the fold <code>loading="lazy"</code>: those are not waited for.
        </li>
        <li>Back and forward fade the same way. A navigation started during a transition skips it and lands on the newer page.</li>
        <li>
          With <code>prefers-reduced-motion: reduce</code>, without the API, or with <code>data-brust-transition="off"</code> on <code>&lt;html&gt;</code>, the page swaps at once.
        </li>
      </ul>
      <p>
        Customise it with the standard <code>::view-transition-*</code> CSS, or give your own elements a <code>view-transition-name</code>:
      </p>
      <CodeBlock code={blocks.vt.code} lang={blocks.vt.lang} file={blocks.vt.file} html={blocks.vt.html} />

      <h2 id="navigate">navigate()</h2>
      <CodeBlock code={blocks.go.code} lang={blocks.go.lang} file={blocks.go.file} html={blocks.go.html} />
      <p>
        <code>navigate(url, {'{ replace }'})</code> runs the same flow with <code>trigger: 'navigate'</code> and resolves after <code>success</code> or <code>error</code>. Call it from an event handler, an effect or an island. In server code, or
        while rendering on the server, it throws <code>navigate is browser-only</code>. When the page has no <code>nav</code> script, it does <code>location.assign(url)</code>, or <code>location.replace(url)</code> with{' '}
        <code>replace: true</code>.
      </p>
      <p>
        <code>@brust/core</code> also exports <code>clearNavigationCache()</code> and the types <code>NavigateOptions</code>, <code>NavTrigger</code>, <code>NavLoadDetail</code>, <code>NavSuccessDetail</code> and <code>NavErrorDetail</code>.
      </p>

      <h2 id="navigation-store">The navigation store</h2>
      <p>
        The events are the low-level contract. For a component, brust ships one built-in store that mirrors them, so you read navigation state the way you read any other store:
      </p>
      <CodeBlock code={blocks.spinner.code} lang={blocks.spinner.lang} file={blocks.spinner.file} html={blocks.spinner.html} />
      <p>
        It works in a native component and in a React island, and the first paint matches: the server renders <code>state: 'idle'</code> and <code>url</code> as the request's path and query, so hydration finds the markup it expects.
      </p>
      <table>
        <thead>
          <tr>
            <th>Key</th>
            <th>Type</th>
            <th>Meaning</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>state</code>
            </td>
            <td>
              <code>'idle' | 'loading'</code>
            </td>
            <td>
              <code>'loading'</code> from <code>brust:nav:load</code> until <code>success</code> or <code>error</code>
            </td>
          </tr>
          <tr>
            <td>
              <code>url</code>
            </td>
            <td>
              <code>string</code>
            </td>
            <td>Path and query of the page on screen. Updated at <code>success</code>, and at <code>error</code> when the error page was swapped in</td>
          </tr>
          <tr>
            <td>
              <code>to</code>
            </td>
            <td>
              <code>string | null</code>
            </td>
            <td>Path and query being loaded, else <code>null</code></td>
          </tr>
          <tr>
            <td>
              <code>trigger</code>
            </td>
            <td>
              <code>'link' | 'navigate' | 'popstate' | null</code>
            </td>
            <td>Of the current or last navigation</td>
          </tr>
          <tr>
            <td>
              <code>status</code>
            </td>
            <td>
              <code>number | null</code>
            </td>
            <td>HTTP status of the last navigation</td>
          </tr>
          <tr>
            <td>
              <code>error</code>
            </td>
            <td>
              <code>string | null</code>
            </td>
            <td>The message of the last failed navigation, cleared at the next <code>load</code>. A swapped 404 reads <code>HTTP 404</code></td>
          </tr>
          <tr>
            <td>
              <code>id</code>
            </td>
            <td>
              <code>number</code>
            </td>
            <td>The last navigation id (<code>0</code> before any)</td>
          </tr>
        </tbody>
      </table>
      <ul>
        <li>
          It is a normal store: <code>navigation.state.subscribe(...)</code> works in a plain script and <code>navigation.snapshot()</code> gives plain values. Do not write it; the next event overwrites a write.
        </li>
        <li>
          <code>navigation</code> is a reserved store name. A <code>defineStore('navigation', …)</code> of your own that a component reads is a build error (<code>store-name-reserved</code>).
        </li>
        <li>
          A component that reads <code>url</code> depends on the URL, so a layout that reads it renders different markup on every page and is replaced on every navigation instead of kept. Read <code>to</code> and <code>state</code> in a layout, and{' '}
          <code>url</code> where a page-level component is fine.
        </li>
        <li>The module listens for the events once, when the first chunk that imports it loads. A navigation that is already loading at that moment shows <code>idle</code> until its <code>success</code>.</li>
      </ul>

      <h2 id="stores">Stores and islands</h2>
      <Note tag="Exception">
        A store that is already live keeps its client value across a navigation. The new page's snapshot only seeds a store the tab has not used yet. It is the one place a navigation differs from a full load, and it matches React apps. See{' '}
        <a href="/docs/store">Store</a>.
      </Note>
      <p>
        When a page leaves the document, its islands are unmounted and their effect cleanups run, as on a React route change. The islands of the new page hydrate when idle, as on a full load.
      </p>
    </>
  )
}
