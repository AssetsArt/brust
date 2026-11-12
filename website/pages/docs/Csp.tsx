// Content Security Policy — `[csp]` in brust.toml: the policy brust sends, the hashes of its own inline scripts, the keys, inline styles,
// report-only, a loader's own header, and what is not covered yet.
// Source of truth: crates/brust-core/src/csp.rs (compose, validate, the header stamp), crates/brust-core/src/core.rs (hashes at Core::new,
// Core::finish), packages/brust/src/config.ts (parseCsp / checkCsp), packages/brust/src/run.ts (not under brust dev),
// packages/runtime-dom/src/nav/nav.ts (the progress bar's constructable sheet) and the served test tests/server/csp.chromium.test.ts,
// whose fixture is packages/brust/test/fixtures/csp-app.
// This page is static.
import CodeBlock from '../../components/CodeBlock'
import Lead from '../../components/docs/Lead'
import Note from '../../components/docs/Note'
import { type CodeBlockData, codeBlock } from '../../lib/highlight'
import type { TocItem } from '../../lib/nav'

export interface CspData {
  toc: TocItem[]
  blocks: Record<'on' | 'policy' | 'full' | 'styles', CodeBlockData>
}

const ON = `# brust.toml
[csp]
enabled = true`

const POLICY = `Content-Security-Policy: default-src 'self'; script-src 'self' 'sha256-…'; style-src-elem 'self';
  style-src-attr 'unsafe-inline'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'`

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
report_uri = "/csp-report"`

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
      { id: 'inline-styles', title: 'Inline styles' },
      { id: 'inline-scripts', title: 'Inline scripts' },
      { id: 'report-only', title: 'Report-only' },
      { id: 'your-own', title: 'Your own header' },
      { id: 'where', title: 'Where it applies' },
    ],
    blocks: {
      on: codeBlock({ lang: 'text', file: 'brust.toml', code: ON }),
      policy: codeBlock({ lang: 'text', file: 'response header', code: POLICY }),
      full: codeBlock({ lang: 'text', file: 'brust.toml', code: FULL }),
      styles: codeBlock({ lang: 'text', file: 'brust.toml', code: STYLES }),
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
        Each list adds sources to its directive, after <code>&apos;self&apos;</code>. <code>style_src</code> goes into <code>style-src-elem</code>. <code>img_src</code>, <code>font_src</code> and <code>frame_ancestors</code> are sent only when you set them.
        Without <code>frame_ancestors</code>, framing is not restricted, as it is without <code>[csp]</code>.
      </p>
      <p>
        One entry is one source: a host (<code>https://cdn.example.com</code>), a scheme (<code>data:</code>) or a quoted keyword (<code>&apos;self&apos;</code>, <code>&apos;none&apos;</code>, <code>&apos;unsafe-inline&apos;</code>,{' '}
        <code>&apos;nonce-…&apos;</code>, <code>&apos;sha256-…&apos;</code>). An entry with <code>;</code>, <code>,</code>, a line break, a non-ASCII character or an unbalanced quote is refused, so no entry can end the directive and start another.
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
        <code>&apos;unsafe-inline&apos;</code> (next to brust&rsquo;s hashes browsers ignore it anyway), <code>&apos;unsafe-eval&apos;</code>, <code>&apos;unsafe-hashes&apos;</code>, <code>*</code>, and a bare scheme such as <code>https:</code>,{' '}
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
        A loader that sets its own <code>Content-Security-Policy</code> header (in <code>res.headers</code>) keeps it: brust adds its header only to a response that does not have one. The header is not part of the cached page, so a page served from the
        cache gets the same header as a fresh render.
      </p>

      <h2 id="where">Where it applies</h2>
      <ul>
        <li>
          Every HTML response of <code>brust start</code>, and the pages a Cloudflare Worker renders (<code>--target cloudflare</code>). Assets, actions and other non-HTML responses get no header.
        </li>
        <li>
          <code>brust dev</code> sends none: its overlay and devtools add <code>&lt;style&gt;</code> elements a strict policy would block. Check your policy with <code>brust start</code>.
        </li>
      </ul>
      <Note>
        <code>--target static</code> pages and the static assets of the Cloudflare target are served by the platform, not by brust, so they get no header from <code>[csp]</code> yet. Set the header in your host&rsquo;s configuration for those.
      </Note>
    </>
  )
}
