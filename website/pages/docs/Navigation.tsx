// Navigation — links swap the page in place, the one rule, what is swapped, opt-outs, prefetch, the brust:nav:* events, a preloader, navigate().
// Source of truth: docs/navigation.md and the SPA navigation design. This page is static: the docs site you are reading navigates this way.
import CodeBlock from '../../components/CodeBlock'
import Lead from '../../components/docs/Lead'
import Note from '../../components/docs/Note'
import { type CodeBlockData, codeBlock } from '../../lib/highlight'
import type { TocItem } from '../../lib/nav'

export interface NavigationData {
  toc: TocItem[]
  blocks: Record<'tag' | 'bar' | 'barCss' | 'go' | 'persist', CodeBlockData>
}

const TAG = `<script type="module" src="/_brust/client/nav-3f9c1a07b2.js"
  data-brust-nav data-brust-build="9a41c0e7" data-brust-root="root:5b1d0c33"></script>`

const BAR = `document.addEventListener('brust:nav:load', () => bar.start())
document.addEventListener('brust:nav:success', () => bar.done())
document.addEventListener('brust:nav:error', (e) => {
  bar.done()
  if (!e.detail.swapped) report(e.detail.error)
})`

const BAR_CSS = `.bar { transform: scaleX(0); transform-origin: left; }
html[data-brust-loading] .bar {
  transform: scaleX(.8);
  transition: transform 8s cubic-bezier(.1, .8, .2, 1);
}`

const GO = `import { navigate } from '@brust/core'

navigate('/docs/store')                                // push an entry
await navigate('/search?q=brust', { replace: true })   // replace the current one`

const PERSIST = `<audio data-brust-persist="player" src="/public/live.mp3" controls></audio>`

export async function navigationLoader(): Promise<NavigationData> {
  return {
    toc: [
      { id: 'rule', title: 'The one rule' },
      { id: 'swap', title: 'What is swapped' },
      { id: 'clicks', title: 'Which clicks navigate' },
      { id: 'opt-outs', title: 'Opt-outs' },
      { id: 'prefetch', title: 'Prefetch' },
      { id: 'events', title: 'Events' },
      { id: 'preloader', title: 'A preloader' },
      { id: 'navigate', title: 'navigate()' },
      { id: 'stores', title: 'Stores and islands' },
    ],
    blocks: {
      tag: codeBlock({ lang: 'text', file: 'view-source', code: TAG }),
      bar: codeBlock({ lang: 'ts', file: 'bar.ts', code: BAR }),
      barCss: codeBlock({ lang: 'text', file: 'app.css', code: BAR_CSS }),
      go: codeBlock({ lang: 'ts', file: 'Search.tsx', code: GO }),
      persist: codeBlock({ lang: 'text', file: 'Layout.tsx', code: PERSIST }),
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
          <b>Scroll</b>: the new page scrolls to its <code>#hash</code> target or to the top. Back and forward restore the position the entry had. A link to the URL already on screen re-fetches it without a new history entry.
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
        </tbody>
      </table>
      <CodeBlock code={blocks.persist.code} lang={blocks.persist.lang} file={blocks.persist.file} html={blocks.persist.html} />
      <p>
        There is no config key: the attribute is the opt-out. A classic <code>&lt;script&gt;</code> in the head that is new to the page runs. After a whole-body swap, every classic head script runs again in order, as on a full load, which keeps a theme
        script that sets <code>&lt;html class&gt;</code> correct. A script in a layout that was kept does not run again.
      </p>

      <h2 id="prefetch">Prefetch</h2>
      <p>
        brust fetches a link's page when you show intent: after 65 ms of hover, on focus, or at once on <code>touchstart</code>. The click then uses that response, which is held for 15 seconds and used once. Prefetch is off when the browser asks to
        save data or is on a <code>2g</code> connection, and for the opt-outs above. A prefetch fires no events.
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
          The order is <code>click</code> (link clicks only), <code>load</code>, then exactly one of <code>success</code> or <code>error</code>. A newer navigation aborts the one in flight, and the aborted one fires nothing more.
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

      <h2 id="preloader">A preloader</h2>
      <p>With the events:</p>
      <CodeBlock code={blocks.bar.code} lang={blocks.bar.lang} file={blocks.bar.file} html={blocks.bar.html} />
      <p>Or in CSS alone, with no JavaScript:</p>
      <CodeBlock code={blocks.barCss.code} lang={blocks.barCss.lang} file={blocks.barCss.file} html={blocks.barCss.html} />

      <h2 id="navigate">navigate()</h2>
      <CodeBlock code={blocks.go.code} lang={blocks.go.lang} file={blocks.go.file} html={blocks.go.html} />
      <p>
        <code>navigate(url, {'{ replace }'})</code> runs the same flow with <code>trigger: 'navigate'</code> and resolves after <code>success</code> or <code>error</code>. Call it from an event handler, an effect or an island. In server code, or
        while rendering on the server, it throws <code>navigate is browser-only</code>. When the page has no <code>nav</code> script, it does <code>location.assign(url)</code>, or <code>location.replace(url)</code> with{' '}
        <code>replace: true</code>.
      </p>
      <p>
        <code>@brust/core</code> also exports the types <code>NavigateOptions</code>, <code>NavTrigger</code>, <code>NavLoadDetail</code>, <code>NavSuccessDetail</code> and <code>NavErrorDetail</code>.
      </p>

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
