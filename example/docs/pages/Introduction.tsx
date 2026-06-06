// Native page — rendered to HTML in Rust. Prose + callouts authored as literal
// markup (className literals only); code samples arrive pre-highlighted from the
// loader and render through the native <CodeBlock>.
import { Info, TriangleAlert } from 'lucide-react'
import CodeBlock from '../components/CodeBlock'

export default function Introduction({ bootHtml }: { bootHtml: string }) {
  return (
    <article className="b-prose">
      <header className="b-pagehead">
        <p className="b-eyebrow">Getting Started</p>
        <h1>Introduction</h1>
        <p className="b-lead">
          brust is a server-side rendering framework for the web. A Rust HTTP server (hyper) runs
          inside Bun through a native addon — so your app gets Rust's throughput and Bun's developer
          experience in one process.
        </p>
      </header>

      <p>
        Most JavaScript frameworks put a Node or Bun process in front of your app and ask it to do
        everything: accept connections, parse requests, render React, and serialize the response.
        brust splits the work. <strong>Bun owns your code and your build.</strong> A{' '}
        <strong>Rust server (hyper) owns the socket</strong> — accepting connections, multiplexing
        HTTP/2, and rendering <code>native</code> routes to HTML without ever entering the JS
        runtime.
      </p>

      <div className="b-callout b-callout--info">
        <span className="b-callout__ic">
          <Info size={18} />
        </span>
        <div className="b-callout__body">
          <p className="b-callout__title">The short version</p>
          <p>
            A hyper server is compiled into a Bun-loadable native module. Bun calls into it to start
            listening; Rust calls back into Bun for the routes that need JavaScript. One process,
            two runtimes.
          </p>
        </div>
      </div>

      <CodeBlock native html={bootHtml} lang="tsx" />

      <h2 id="what-you-get">What you get</h2>
      <ul>
        <li>
          <strong>Streaming SSR</strong> with React 19 — <code>renderToPipeableStream</code> with
          automatic Suspense, so the shell ships on the first byte.
        </li>
        <li>
          <strong>Native routes</strong> — JSX compiled to a minijinja template and rendered in
          Rust. No React on the server, nothing to hydrate on the client.
        </li>
        <li>
          <strong>Islands</strong> — opt-in hydration. Interactive components ship as on-demand
          chunks; everything else is static HTML.
        </li>
        <li>
          <strong>A signal store</strong> shared across chunks through a single <code>window</code>{' '}
          singleton.
        </li>
        <li>
          <strong>Typed actions</strong> — a treaty-style client inferred from your server file with
          no codegen.
        </li>
        <li>
          <strong>Agent-native</strong> — every action becomes an MCP tool, every loader a resource,
          served at <code>/_brust/mcp</code>.
        </li>
      </ul>

      <h2 id="when-to-use">When to reach for brust</h2>
      <p>
        brust is built for content- and data-heavy apps that want most of the page to be static HTML
        but need real interactivity in a few places — dashboards, storefronts, docs, consoles. If
        you want a Rust-grade server without leaving the TypeScript ecosystem, this is the trade
        brust makes for you.
      </p>

      <div className="b-callout b-callout--warning">
        <span className="b-callout__ic">
          <TriangleAlert size={18} />
        </span>
        <div className="b-callout__body">
          <p className="b-callout__title">Alpha</p>
          <p>
            brust is <code>v0.1</code>. The native-route compiler and the action client are stable
            enough to build on; the islands runtime API may still shift before <code>1.0</code>. Pin
            your version.
          </p>
        </div>
      </div>

      <h2 id="next">Where to go next</h2>
      <p>
        Install the toolchain and scaffold an app on the{' '}
        <a href="/docs/installation">Installation</a> page, then build your{' '}
        <a href="/docs/first-route">first route</a>. If you'd rather understand the model first,
        jump to <a href="/docs/rendering">Rendering</a>.
      </p>
    </article>
  )
}
