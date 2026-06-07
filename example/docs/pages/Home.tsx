// Landing — a STANDALONE native route (sibling of the doc Layout, so it renders
// full-width with no sidebar). It owns its own chrome: the glass topbar (with the
// native SearchTrigger + ThemeToggle behaviors and the ⌘K SearchPalette island),
// the Grainient hero, a feature grid, a live native counter, a CTA band, and the
// footer. Everything is native (zero React server-side) except the two islands.
import {
  ArrowRight,
  Bot,
  Boxes,
  GitFork,
  Layers,
  Server,
  Sparkles,
  Webhook,
  Zap,
} from 'lucide-react'
import { BrustPage, Island } from 'brustjs'
import Counter from '../components/Counter'
import Example from '../components/Example'
import Grainient from '../components/Grainient.island'
import SearchPalette from '../components/SearchPalette.island'
import SearchTrigger from '../components/SearchTrigger'
import ThemeToggle from '../components/ThemeToggle'

export default function Home({
  counterHtml,
  version,
  repo,
}: {
  counterHtml: string
  version: string
  repo: string
}) {
  return (
    <BrustPage lang="en" data-mode="dark" title="brust — fast SSR for Bun + Rust">
      <div className="b-canvas min-h-screen">
        {/* ── hero (the navbar floats over the grainient, reactbits-style) ── */}
        <section className="relative overflow-hidden">
          {/* reactbits Grainient as a React island; the b-hero-bg gradient is a
              static fallback shown until the canvas hydrates (no flash). */}
          <div className="b-hero-bg absolute inset-0" aria-hidden="true">
            <Island component={Grainient} hydrate="load" />
            <div className="b-hero-overlay"></div>
          </div>
          <header className="b-topbar b-topbar--hero">
            <a href="/" className="flex items-center gap-2.5" aria-label="brust home">
              <span className="b-wordmark text-base font-extrabold tracking-tight">Brust</span>
            </a>
            <div className="flex flex-1 justify-center px-2">
              <SearchTrigger native />
            </div>
            <div className="flex items-center gap-1">
              <ThemeToggle native />
              <a
                href={repo}
                target="_blank"
                rel="noopener noreferrer"
                className="b-iconbtn grid h-9 w-9 place-items-center rounded-lg transition-colors"
                aria-label="GitHub repository"
              >
                <GitFork size={18} />
              </a>
              <a
                href="/docs/introduction"
                className="b-getstarted ml-1 hidden h-9 items-center gap-1.5 rounded-xl px-3.5 text-[13.5px] font-semibold transition-transform sm:inline-flex"
              >
                Get started <ArrowRight size={15} />
              </a>
            </div>
          </header>
          <div className="relative mx-auto max-w-5xl px-6 pt-28 pb-24">
            <div className="b-fade-up max-w-2xl">
              <span className="b-hero-pill mb-7 inline-flex items-center gap-2 rounded-full py-1 pr-3 pl-1.5">
                <span className="inline-flex items-center gap-1 rounded-full bg-white/20 px-2 py-0.5 text-[11px] font-bold tracking-wide text-white">
                  <Sparkles size={11} /> NEW
                </span>
                <span className="text-[13px] font-medium text-white/85">
                  v{version} — Rust in Bun, shipping now
                </span>
              </span>
              <h1 className="font-display text-5xl font-black leading-[1.02] tracking-tight text-white sm:text-6xl">
                Fast SSR for Bun <span className="font-light text-white/40">+</span>{' '}
                <span className="b-gradient-text">Rust</span>
              </h1>
              <p className="mt-6 max-w-xl text-lg leading-relaxed text-white/80">
                brust embeds a hyper HTTP server inside Bun through a native addon. Stream React 19,
                render routes in Rust with zero client JS, and get a typed API that agents can
                drive. This site is itself a native brust app — every example below is real.
              </p>
              <div className="mt-9 flex flex-wrap items-center gap-3">
                <a
                  href="/docs/introduction"
                  className="b-hero-cta inline-flex h-12 items-center gap-2 rounded-xl px-6 text-[15px] font-semibold text-white transition-transform"
                >
                  Get started <ArrowRight size={17} />
                </a>
                <a
                  href={repo}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="b-hero-ghost inline-flex h-12 items-center gap-2 rounded-xl px-5 text-[15px] font-semibold text-white transition-colors"
                >
                  <GitFork size={17} /> GitHub
                </a>
              </div>
            </div>
            {/* Interactive, not a static snippet: a real native directive component
                running live in the hero (click it; open the source for the real file). */}
            <div className="b-fade-up b-hero-demo mt-14 max-w-2xl">
              <Example
                native
                title="Live · native interactivity · zero React"
                codeHtml={counterHtml}
              >
                <Counter native />
              </Example>
            </div>
          </div>
        </section>

        {/* ── feature grid ── */}
        <section className="mx-auto max-w-5xl px-6 pt-20 pb-6">
          <p className="b-eyebrow">Why brust</p>
          <h2 className="font-display text-3xl font-extrabold tracking-tight text-slate-900 sm:text-4xl dark:text-white">
            Two runtimes, one framework
          </h2>
          <p className="mt-3 max-w-2xl text-[17px] leading-relaxed text-slate-600 dark:text-slate-300">
            Bun runs your JavaScript and your build. Rust serves the bytes and renders native
            routes. You write one app; brust decides what runs where.
          </p>

          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <a href="/docs/rendering" className="b-feature-card block">
              <span className="b-feature-ic">
                <Server size={21} />
              </span>
              <h3 className="font-display text-[17px] font-bold text-slate-900 dark:text-white">
                Native routes
              </h3>
              <p className="mt-1.5 text-[14.5px] leading-relaxed text-slate-600 dark:text-slate-400">
                Compile JSX to a minijinja template and render it in Rust — zero React on the
                server, zero hydration. The fastest path to HTML.
              </p>
            </a>
            <a href="/docs/store" className="b-feature-card block">
              <span className="b-feature-ic">
                <Boxes size={21} />
              </span>
              <h3 className="font-display text-[17px] font-bold text-slate-900 dark:text-white">
                Islands + store
              </h3>
              <p className="mt-1.5 text-[14.5px] leading-relaxed text-slate-600 dark:text-slate-400">
                Hydrate a React component as an island inside a native route. A signal store shares
                state across islands and native components — one window singleton.
              </p>
            </a>
            <a href="/docs/actions" className="b-feature-card block">
              <span className="b-feature-ic">
                <Webhook size={21} />
              </span>
              <h3 className="font-display text-[17px] font-bold text-slate-900 dark:text-white">
                Typed actions
              </h3>
              <p className="mt-1.5 text-[14.5px] leading-relaxed text-slate-600 dark:text-slate-400">
                defineActions gives you an end-to-end typed client — no codegen. Infer the whole API
                from the server file.
              </p>
            </a>
            <a href="/docs/agents" className="b-feature-card block">
              <span className="b-feature-ic">
                <Bot size={21} />
              </span>
              <h3 className="font-display text-[17px] font-bold text-slate-900 dark:text-white">
                Agent-first (MCP)
              </h3>
              <p className="mt-1.5 text-[14.5px] leading-relaxed text-slate-600 dark:text-slate-400">
                Every action auto-becomes an MCP tool at /_brust/mcp and every loader a resource.
                Agents drive your app without scraping.
              </p>
            </a>
            <a href="/docs/rendering" className="b-feature-card block">
              <span className="b-feature-ic">
                <Layers size={21} />
              </span>
              <h3 className="font-display text-[17px] font-bold text-slate-900 dark:text-white">
                Streaming SSR
              </h3>
              <p className="mt-1.5 text-[14.5px] leading-relaxed text-slate-600 dark:text-slate-400">
                React 19 renderToPipeableStream with automatic Suspense. First byte ships while the
                rest of the tree resolves.
              </p>
            </a>
            <a href="/docs/deployment" className="b-feature-card block">
              <span className="b-feature-ic">
                <Zap size={21} />
              </span>
              <h3 className="font-display text-[17px] font-bold text-slate-900 dark:text-white">
                Fast by default
              </h3>
              <p className="mt-1.5 text-[14.5px] leading-relaxed text-slate-600 dark:text-slate-400">
                A hyper HTTP server embedded in Bun through a native napi addon. HTTP/1.1 + HTTP/2,
                glibc and musl.
              </p>
            </a>
          </div>
        </section>

        {/* ── CTA band ── */}
        <section className="mx-auto max-w-5xl px-6 pt-12 pb-20">
          <div className="b-cta-band">
            <div className="grainient grainient--subtle" aria-hidden="true">
              <div className="grainient__mesh"></div>
              <div className="grainient__mesh--b"></div>
              <div className="grainient__grain"></div>
              <div className="grainient__vignette"></div>
            </div>
            <div className="relative px-8 py-14 text-center">
              <h2 className="mx-auto max-w-xl font-display text-3xl font-black leading-tight text-white sm:text-4xl">
                Spin up an app in one command
              </h2>
              <p className="mx-auto mt-4 max-w-md text-[17px] text-white/75">
                The dev server boots in milliseconds. Production builds compile native routes ahead
                of time.
              </p>
              <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
                <a
                  href="/docs/introduction"
                  className="b-hero-ghost inline-flex h-12 items-center gap-2 rounded-xl px-6 text-[15px] font-semibold text-white transition-colors"
                >
                  Read the docs <ArrowRight size={16} />
                </a>
                <code className="inline-flex h-12 items-center rounded-xl border border-white/15 bg-black/25 px-4 font-mono text-[14px] text-white/85">
                  bun create brustjs my-app
                </code>
              </div>
            </div>
          </div>
        </section>

        {/* ── footer (inlined — native nested-component inlining is fragile) ── */}
        <footer className="b-footer">
          <div className="mx-auto max-w-5xl px-6 py-14">
            <div className="grid gap-10 md:grid-cols-4">
              <div className="md:col-span-2 md:max-w-xs">
                <div className="mb-3 flex items-center gap-2.5">
                  <span className="b-logo-mark grid h-7 w-7 place-items-center rounded-lg">
                    <Zap size={15} />
                  </span>
                  <span className="b-wordmark font-extrabold">brust</span>
                </div>
                <p className="b-muted text-[14px] leading-relaxed">
                  SSR for the web — a Rust HTTP server embedded in Bun. Streaming React, native
                  routes, typed actions, agent-ready.
                </p>
                <div className="mt-5 flex items-center gap-2">
                  <a
                    href={repo}
                    className="b-social grid h-9 w-9 place-items-center rounded-lg"
                    aria-label="GitHub"
                  >
                    <GitFork size={17} />
                  </a>
                </div>
              </div>
              <div>
                <p className="b-footer-col-label">Docs</p>
                <a href="/docs/introduction" className="b-footer-link">
                  Introduction
                </a>
                <a href="/docs/routing" className="b-footer-link">
                  Routing
                </a>
                <a href="/docs/rendering" className="b-footer-link">
                  Rendering
                </a>
                <a href="/docs/actions" className="b-footer-link">
                  Actions &amp; API
                </a>
              </div>
              <div>
                <p className="b-footer-col-label">Platform</p>
                <a href="/docs/agents" className="b-footer-link">
                  Agents · MCP
                </a>
                <a href="/docs/cli" className="b-footer-link">
                  CLI
                </a>
                <a href="/docs/deployment" className="b-footer-link">
                  Deployment
                </a>
                <a href="/docs/styling" className="b-footer-link">
                  Styling
                </a>
              </div>
            </div>
            <div className="b-footer-rule mt-12 flex flex-col items-start justify-between gap-3 pt-6 sm:flex-row sm:items-center">
              <span className="b-muted text-[13px]">© 2026 brust · MIT licensed · v{version}</span>
              <span className="b-muted inline-flex items-center gap-1.5 text-[13px]">
                Built with <Zap size={13} /> brust
              </span>
            </div>
          </div>
        </footer>

        <Island component={SearchPalette} hydrate="load" />
      </div>
    </BrustPage>
  )
}
