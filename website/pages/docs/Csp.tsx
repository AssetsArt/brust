// Content Security Policy — `[csp]` in brust.toml: the policy brust sends, the hashes of its own inline scripts, the keys, inline styles,
// report-only, a loader's own header, and what is not covered yet.
// Source of truth: crates/brust-core/src/csp.rs (compose, validate, the header stamp), crates/brust-core/src/core.rs (hashes at Core::new,
// Core::finish), packages/brust/src/config.ts (parseCsp / checkCsp), packages/brust/src/run.ts (not under brust dev),
// packages/runtime-dom/src/nav/nav.ts (the progress bar's constructable sheet) and the served test tests/server/csp.chromium.test.ts,
// whose fixture is packages/brust/test/fixtures/csp-app.
// This page is static.
import CodeBlock from '../../components/CodeBlock'
import Lead from '../../components/docs/Lead'
import { type CodeBlockData, codeBlock } from '../../lib/highlight'
import type { TocItem } from '../../lib/nav'

export interface CspData {
  toc: TocItem[]
  blocks: Record<'on' | 'policy' | 'full' | 'styles' | 'none' | 'host' | 'dev', CodeBlockData>
}

const ON = `# brust.toml
[csp]
enabled = true`

const POLICY = `Content-Security-Policy: default-src 'self'; script-src 'self' 'sha256-…'; style-src-elem 'self';
  style-src-attr 'unsafe-inline'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; form-action 'self'`

const FULL = `# brust.toml (every key optional)
[csp]
enabled = true
mode = "enforce"                         # or "report-only"
script_src = ["https://cdn.example.com"]
style_src = ["https://fonts.googleapis.com"]
connect_src = ["wss://live.example.com"]
img_src = ["data:", "https://images.example.com"]
font_src = ["https://fonts.gstatic.com"]
frame_ancestors = ["'none'"]
report_uri = "/csp-report"
form_action = ["https://pay.example.com"]
frame_src = ["https://www.youtube-nocookie.com"]
media_src = ["https://media.example.com"]
worker_src = ["blob:"]
manifest_src = []
object_src = []                          # empty = 'none'
default_src = "self"                     # or "none"
base_uri = "self"                        # or "none"`

const NONE = `# brust.toml: nothing is allowed unless named
[csp]
enabled = true
default_src = "none"`

const HOST = `# brust.toml: one app serving many host names, each page's socket on its own host
[csp]
enabled = true
connect_src = ["wss://{host}"]`

const DEV = `# brust.toml
[csp]
enabled = true
dev = true                 # send it under brust dev too
dev_mode = "enforce"       # default "report-only" under brust dev`

const STYLES = `# brust.toml: an app that writes <style> inline (for example with dangerouslySetInnerHTML)
[csp]
enabled = true
style_src = ["'unsafe-inline'"]`

export async function cspLoader(): Promise<CspData> {
  return {
    toc: [
      { id: 'turn-on', title: 'Turning it on' },
      { id: 'policy', title: 'The policy brust sends' },
      { id: 'keys', title: 'Adding sources' },
      { id: 'none', title: "default-src 'none'" },
      { id: 'host', title: 'The request host' },
      { id: 'inline-styles', title: 'Inline styles' },
      { id: 'inline-scripts', title: 'Inline scripts' },
      { id: 'report-only', title: 'Report-only' },
      { id: 'your-own', title: 'Your own header' },
      { id: 'switch', title: 'Switching it per deploy' },
      { id: 'dev', title: 'Under brust dev' },
      { id: 'where', title: 'Where it applies' },
      { id: 'static', title: 'Static sites' },
    ],
    blocks: {
      on: codeBlock({ lang: 'text', file: 'brust.toml', code: ON }),
      policy: codeBlock({ lang: 'text', file: 'response header', code: POLICY }),
      full: codeBlock({ lang: 'text', file: 'brust.toml', code: FULL }),
      styles: codeBlock({ lang: 'text', file: 'brust.toml', code: STYLES }),
      none: codeBlock({ lang: 'text', file: 'brust.toml', code: NONE }),
      host: codeBlock({ lang: 'text', file: 'brust.toml', code: HOST }),
      dev: codeBlock({ lang: 'text', file: 'brust.toml', code: DEV }),
    },
  }
}

export default function Csp({ blocks }: CspData) {
  return (
    <>
      <h1>Content Security Policy</h1>
      <Lead>
        With <code>[csp]</code> on, brust sends a strict <code>Content-Security-Policy</code> header with every HTML page. Scripts may come only from your own origin, plus the few small inline scripts brust writes itself, which the policy lists by their hash.
      </Lead>

      <h2 id="turn-on">Turning it on</h2>
      <CodeBlock code={blocks.on.code} lang={blocks.on.lang} file={blocks.on.file} html={blocks.on.html} />
      <p>
        It is off by default: without <code>enabled = true</code> no header is sent and nothing changes. The table is checked either way, so a mistake in it stops <code>brust start</code> with a <code>csp: …</code> error. A key brust does not know is an
        error too, so a misspelt directive cannot pass unnoticed.
      </p>

      <h2 id="policy">The policy brust sends</h2>
      <CodeBlock code={blocks.policy.code} lang={blocks.policy.lang} file={blocks.policy.file} html={blocks.policy.html} />
      <ul>
        <li>
          <strong>
            <code>script-src</code>
          </strong>{' '}
          allows your own origin and one <code>sha256</code> hash for each inline script brust writes: the base path global (with <code>[server] base_path</code>) and the actions client globals (a non-default <code>[actions] prefix</code>, a{' '}
          <code>base_url</code> or <code>credentials</code>). These scripts are the same for every page of a running server, so brust computes their hashes once at startup. Everything else brust adds to a page is a <code>src</code> script from your origin, or
          a JSON data block, which the policy does not govern.
        </li>
        <li>
          <strong>
            <code>style-src-elem &apos;self&apos;</code>
          </strong>{' '}
          allows stylesheets from your origin (your CSS, Tailwind and CSS modules). The navigation progress bar builds its styles through the CSSOM, which this does not block. Its rules have no specificity, so any rule of yours on{' '}
          <code>div[data-brust-bar]</code> overrides them.
        </li>
        <li>
          <strong>
            <code>style-src-attr &apos;unsafe-inline&apos;</code>
          </strong>{' '}
          is the one relaxation brust always sends. The compiler prints <code>style=&quot;…&quot;</code> attributes and <code>x-bind-style</code> sets them at runtime; their values change with your data, so they cannot be hashed. A style attribute cannot run
          script.
        </li>
        <li>
          <strong>
            <code>style-src &apos;self&apos; &apos;unsafe-inline&apos;</code>
          </strong>{' '}
          is a fallback for browsers that do not know the two directives above (Safari before 15.4). Browsers that know them ignore <code>style-src</code>, so for them the policy is the stricter one. Your <code>style_src</code> sources are added to it too.
          It covers styles only; scripts stay strict everywhere.
        </li>
        <li>
          <code>connect-src</code> is sent only when it has more than your own origin: the actions <code>base_url</code> when it is another origin, and your <code>connect_src</code> list. Otherwise <code>default-src &apos;self&apos;</code> covers it.
        </li>
      </ul>

      <h2 id="keys">Adding sources</h2>
      <CodeBlock code={blocks.full.code} lang={blocks.full.lang} file={blocks.full.file} html={blocks.full.html} />
      <p>
        Each list adds sources to its directive, after <code>&apos;self&apos;</code>. <code>style_src</code> goes into <code>style-src-elem</code>. <code>img_src</code>, <code>font_src</code>, <code>frame_src</code>, <code>media_src</code>,{' '}
        <code>worker_src</code>, <code>manifest_src</code> and <code>frame_ancestors</code> are sent only when you set them. Without <code>frame_ancestors</code>, framing is not restricted, as it is without <code>[csp]</code>.
      </p>
      <p>
        <code>form-action</code> does not fall back to <code>default-src</code>, so brust always sends <code>form-action &apos;self&apos;</code>, plus your <code>form_action</code> list: a form can post to your own app (actions included) and to the origins you name.{' '}
        <code>object_src</code> replaces <code>&apos;none&apos;</code> when you set it. <code>base_uri</code> is <code>&quot;self&quot;</code> or <code>&quot;none&quot;</code>.
      </p>
      <p>
        One entry is one source: a host (<code>https://cdn.example.com</code>), a scheme (<code>data:</code>) or a quoted keyword (<code>&apos;self&apos;</code>, <code>&apos;none&apos;</code>, <code>&apos;unsafe-inline&apos;</code>,{' '}
        <code>&apos;nonce-…&apos;</code>, <code>&apos;sha256-…&apos;</code>). An entry with <code>;</code>, <code>,</code>, a line break, a non-ASCII character or an unbalanced quote is refused, so no entry can end the directive and start another.
      </p>

      <h2 id="none">default-src &apos;none&apos;</h2>
      <CodeBlock code={blocks.none.code} lang={blocks.none.lang} file={blocks.none.file} html={blocks.none.html} />
      <p>
        With <code>default_src = &quot;none&quot;</code> nothing falls back to your own origin. brust then names what it loads itself: <code>script-src</code> and <code>style-src-elem</code> as above, <code>connect-src &apos;self&apos;</code> (page fetches
        of navigation and prefetch, actions, your WebSockets), <code>img-src &apos;self&apos;</code> (images a navigation preloads, and those brust-built CSS serves) and <code>font-src &apos;self&apos;</code> (fonts brust-built CSS serves). It loads no
        frames, media, workers or manifests, so those stay closed until you list them; then only what you list is allowed (no <code>&apos;self&apos;</code> is added).
      </p>

      <h2 id="host">The request host</h2>
      <CodeBlock code={blocks.host.code} lang={blocks.host.lang} file={blocks.host.file} html={blocks.host.html} />
      <p>
        A source may hold <code>{'{host}'}</code>. brust replaces it with the host the request was sent to (with its port), as each response goes out, so one app serving many host names allows each page its own host. The <code>Host</code> header is
        written by the client, so it is used only when it is a plain host name or IP address with an optional port. Anything else, and every source that holds <code>{'{host}'}</code> is left out of that response&rsquo;s policy: it is never copied
        into the header. <code>{'{host}'}</code> is refused in <code>script_src</code> (a script source taken from the request would let any host name that reaches your server serve script) and in <code>object_src</code> (plugins stay <code>&apos;none&apos;</code> or named hosts). Static pages and the Cloudflare <code>public/</code> rule have no
        request, so the build leaves those sources out and prints a warning. A response whose policy has a <code>{'{host}'}</code> source carries <code>Vary: Host</code>, so a cache in front of brust keeps one copy per host.
      </p>

      <h2 id="inline-styles">Inline styles</h2>
      <p>
        An app that writes <code>&lt;style&gt;</code> elements inline (for example with <code>dangerouslySetInnerHTML</code>) adds <code>&apos;unsafe-inline&apos;</code> to <code>style_src</code>. Scripts stay strict:
      </p>
      <CodeBlock code={blocks.styles.code} lang={blocks.styles.lang} file={blocks.styles.file} html={blocks.styles.html} />

      <h2 id="inline-scripts">Inline scripts</h2>
      <p>
        Under <code>mode = &quot;enforce&quot;</code>, a <code>&lt;script&gt;</code> you write inline is blocked: only brust&rsquo;s own inline scripts are listed. Move the code into a file and load it with <code>src</code>, or run in{' '}
        <a href="#report-only">report-only</a> mode. brust does not add nonces for your inline scripts yet.
      </p>
      <p>
        <code>script_src</code> takes hosts (<code>https://cdn.example.com</code>, <code>*.example.com</code>), and refuses the sources that would let any script run, unless you also set <code>script_src_unsafe = true</code>:{' '}
        <code>&apos;unsafe-inline&apos;</code> (next to brust&rsquo;s hashes browsers ignore it anyway), <code>&apos;unsafe-eval&apos;</code>, <code>&apos;unsafe-hashes&apos;</code>, a host of just <code>*</code> (<code>*</code>, <code>https://*</code>, <code>*:443</code>), and a bare scheme such as <code>https:</code>,{' '}
        <code>data:</code>, <code>blob:</code> or <code>filesystem:</code>. <code>&apos;wasm-unsafe-eval&apos;</code> is allowed. The other lists take all of these freely.
      </p>
      <p>
        <code>&apos;strict-dynamic&apos;</code> is refused in <code>script_src</code> always, even with <code>script_src_unsafe</code>: under it browsers ignore <code>&apos;self&apos;</code> and host sources, so every <code>&lt;script src&gt;</code> brust adds (the
        runtime, islands, navigation) would be blocked. It works only with nonces, which brust does not add yet.
      </p>

      <h2 id="report-only">Report-only</h2>
      <p>
        With <code>mode = &quot;report-only&quot;</code> the same policy goes out as <code>Content-Security-Policy-Report-Only</code>: the browser blocks nothing, and reports each violation in the console (and to <code>report_uri</code> when you set one).
        Start there on an existing app, read what it reports, then switch to <code>&quot;enforce&quot;</code>.
      </p>

      <h2 id="your-own">Your own header</h2>
      <p>
        A loader that sets its own <code>Content-Security-Policy</code> or <code>Content-Security-Policy-Report-Only</code> header (in <code>res.headers</code>) keeps it, and brust adds neither of its own to that response. The header is not part
        of the cached page, so a page served from the cache gets the same header as a fresh render.
      </p>

      <h2 id="switch">Switching it per deploy</h2>
      <p>
        The environment variable <code>BRUST_CSP_MODE</code>, read when the server starts, overrides <code>[csp]</code> without editing <code>brust.toml</code>: <code>off</code> sends no policy; <code>report-only</code> or <code>enforce</code> sends
        it in that mode, from your <code>[csp]</code> table even when <code>enabled</code> is not true (or the default policy when there is no table). Any other value stops the server at startup. On Cloudflare it is a variable of the Worker
        (<code>vars</code> or a dashboard variable), read when the Worker starts. It is the switch to use when a policy breaks a page in production.
      </p>
      <p>
        It reaches only the pages a server or a Worker renders. On <code>--target cloudflare</code>, HTML files in <code>public/</code> are served by the platform with the policy the build wrote into <code>_headers</code>, and on{' '}
        <code>--target static</code> every page carries the policy fixed at build. Switching those needs a rebuild; the Cloudflare build prints <code>warning cf-csp-public</code> when <code>public/</code> holds HTML.
      </p>

      <h2 id="dev">Under brust dev</h2>
      <CodeBlock code={blocks.dev.code} lang={blocks.dev.lang} file={blocks.dev.file} html={blocks.dev.html} />
      <p>
        <code>brust dev</code> sends no policy unless <code>dev = true</code>. Then it sends yours in <code>dev_mode</code> (<code>report-only</code> by default), with one addition its overlay needs: <code>style-src-elem &apos;unsafe-inline&apos;</code>{' '}
        for the error overlay&rsquo;s styles. The dev client, the devtools and their WebSocket are same-origin, which <code>&apos;self&apos;</code> already allows. <code>brust start</code> never gets the addition.
      </p>

      <h2 id="where">Where it applies</h2>
      <ul>
        <li>
          Every HTML response of <code>brust start</code>, and the pages a Cloudflare Worker renders (<code>--target cloudflare</code>). Assets, actions and other non-HTML responses get no header.
        </li>
        <li>
          On <code>--target cloudflare</code>, HTML files you put in <code>public/</code> are served by the platform, not the Worker. When there are any, the build adds the same policy to the <code>/*</code> rule of{' '}
          <code>dist/cf/assets/_headers</code>.
        </li>
        <li>
          <code>--target static</code>: see <a href="#static">Static sites</a>.
        </li>
        <li>
          <code>brust dev</code> sends none unless <code>dev = true</code>: see <a href="#dev">Under brust dev</a>.
        </li>
      </ul>

      <h2 id="static">Static sites</h2>
      <p>
        A <code>brust build --target static</code> page has no server to send a header, so the policy goes into the page: every page, the 404 page included, opens its <code>&lt;head&gt;</code> with{' '}
        <code>&lt;meta http-equiv=&quot;Content-Security-Policy&quot; content=&quot;…&quot;&gt;</code>, the same policy <code>brust start</code> sends, with the same hashes. It is the first element of the head (right after <code>&lt;meta charset&gt;</code> when the head starts with one,
        which must stay within the first 1024 bytes) because a policy in a meta tag applies only to what comes after it. Every page carries the same policy, so navigating between pages without a reload stays inside it.
      </p>
      <ul>
        <li>
          Browsers ignore <code>frame-ancestors</code>, <code>report-uri</code>, <code>report-to</code> and <code>sandbox</code> in a meta tag. When your policy has them, the build puts them in the <code>/*</code> rule of{' '}
          <code>dist/static/_headers</code> as a <code>Content-Security-Policy</code> header, which Cloudflare Pages and Workers Static Assets send for every path. On another host, send that header from its own configuration.
        </li>
        <li>
          A report sent through that header covers only the directives in it. Violations of the meta policy are not reported anywhere: a meta tag cannot name a report URI.
        </li>
        <li>
          <code>mode = &quot;report-only&quot;</code> cannot be a meta tag. In that mode the pages get no meta, and the whole policy goes into the <code>/*</code> rule as <code>Content-Security-Policy-Report-Only</code>.
        </li>
        <li>A page without a <code>&lt;head&gt;</code> stops the build: it would have no policy.</li>
      </ul>
    </>
  )
}
