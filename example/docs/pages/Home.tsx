// Landing — a STANDALONE native route (sibling of the doc Layout, full-width, no
// sidebar). Owns its own chrome: a glass topbar floating over the reactbits
// Grainient island, a unified pitch, a feature grid, a LIVE "one store, two
// runtimes" demo (a react-free native component and a React island sharing one
// signal store), a CTA band, and the footer. Everything is native (zero React
// server-side) except the islands (Grainient, SearchPalette, SharedCounter).
import {
  ArrowRight,
  Bot,
  Boxes,
  GitFork,
  Network,
  Server,
  Sparkles,
  Webhook,
  Zap,
} from 'lucide-react'
import { BrustPage, Island } from 'brustjs'
import Grainient from '../components/Grainient.island'
import SearchPalette from '../components/SearchPalette.island'
import SearchTrigger from '../components/SearchTrigger'
import SharedCounter from '../components/SharedCounter.island'
import SharedNative from '../components/SharedNative'
import ThemeToggle from '../components/ThemeToggle'
import Typewriter from '../components/Typewriter'

export default function Home({ version, repo }: { version: string; repo: string }) {
  return (
    <BrustPage
      lang="en"
      data-mode="dark"
      title="brust — one model: native, islands, actions, agents"
    >
      <div className="b-canvas min-h-screen">
        {/* ── hero (the navbar floats over the grainient, reactbits-style) ── */}
        <section className="relative overflow-hidden">
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
                  v{version} — one model, native to React
                </span>
              </span>
              <h1 className="font-display text-5xl font-black leading-[1.04] tracking-tight text-white sm:text-6xl">
                Separate concerns.
                <br />
                <Typewriter native />
              </h1>
              <p className="mt-6 max-w-xl text-lg leading-relaxed text-white/80">
                brust renders each part of your UI the cheapest way it can — native HTML with zero
                JS, react-free interactivity, or hydrated React islands — and keeps them in sync
                through one shared signal store. The same state flows between native components and
                React islands, and your server functions are typed actions that double as agent
                tools.
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

            {/* LIVE demo — one signal store, shared between a react-free native
                component and a React island. Click either; both stay in sync. */}
            <div className="b-fade-up b-hero-demo mt-14 max-w-2xl">
              <div className="b-demo">
                <div className="b-demo__head">
                  <span className="b-demo__title">One store · two runtimes</span>
                  <span className="b-demo__hint">click either — both stay in sync</span>
                </div>
                <div className="b-demo__grid">
                  <div className="b-demo__cell">
                    <span className="b-demo__label">native · x-* · zero React</span>
                    <SharedNative native />
                  </div>
                  <div className="b-demo__cell">
                    <span className="b-demo__label">React island · useStore</span>
                    <Island component={SharedCounter} hydrate="load" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ── feature grid ── */}
        <section className="mx-auto max-w-5xl px-6 pt-20 pb-6">
          <p className="b-eyebrow">How it fits together</p>
          <h2 className="font-display text-3xl font-extrabold tracking-tight text-slate-900 sm:text-4xl dark:text-white">
            One model, rendered your way
          </h2>
          <p className="mt-3 max-w-2xl text-[17px] leading-relaxed text-slate-600 dark:text-slate-300">
            Pick the right render mode for each component, then keep one reactive store and one
            typed API across all of them. No bridges between native and React — just one app.
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
                JSX compiled to a template and rendered as HTML — zero React, zero hydration. The
                cheapest path to a page.
              </p>
            </a>
            <a href="/docs/native-interactivity" className="b-feature-card block">
              <span className="b-feature-ic">
                <Zap size={21} />
              </span>
              <h3 className="font-display text-[17px] font-bold text-slate-900 dark:text-white">
                Native interactivity
              </h3>
              <p className="mt-1.5 text-[14.5px] leading-relaxed text-slate-600 dark:text-slate-400">
                Add behavior with react-free <code>x-*</code> directives and a co-located behavior.
                Interactive pages that ship almost no JavaScript.
              </p>
            </a>
            <a href="/docs/rendering" className="b-feature-card block">
              <span className="b-feature-ic">
                <Boxes size={21} />
              </span>
              <h3 className="font-display text-[17px] font-bold text-slate-900 dark:text-white">
                React islands
              </h3>
              <p className="mt-1.5 text-[14.5px] leading-relaxed text-slate-600 dark:text-slate-400">
                Need real React? Hydrate a component as an island inside any native page — only that
                subtree ships React.
              </p>
            </a>
            <a href="/docs/store" className="b-feature-card block">
              <span className="b-feature-ic">
                <Network size={21} />
              </span>
              <h3 className="font-display text-[17px] font-bold text-slate-900 dark:text-white">
                One shared store
              </h3>
              <p className="mt-1.5 text-[14.5px] leading-relaxed text-slate-600 dark:text-slate-400">
                <code>signal</code> / <code>computed</code> / <code>effect</code> in a single window
                singleton. Native interactivity and React islands read and write the same state — no
                bridge.
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
                <code>defineActions</code> gives you an end-to-end typed client with no codegen —
                one source of truth for your API.
              </p>
            </a>
            <a href="/docs/agents" className="b-feature-card block">
              <span className="b-feature-ic">
                <Bot size={21} />
              </span>
              <h3 className="font-display text-[17px] font-bold text-slate-900 dark:text-white">
                Agent-ready (MCP)
              </h3>
              <p className="mt-1.5 text-[14.5px] leading-relaxed text-slate-600 dark:text-slate-400">
                Every action is automatically an MCP tool and every loader a resource. Agents drive
                your app through the same typed surface your UI uses.
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
                Build it once. Render it anywhere.
              </h2>
              <p className="mx-auto mt-4 max-w-md text-[17px] text-white/75">
                Native, islands, actions, and agents — one app, one store, one typed API.
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

        {/* ── footer ── */}
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
                  One model for server-first UI — native routes, react-free interactivity, React
                  islands, a shared store, typed actions, and agents.
                </p>
                <div className="mt-5 flex items-center gap-2">
                  <a
                    href={repo}
                    target="_blank"
                    rel="noopener noreferrer"
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
                <a href="/docs/native-interactivity" className="b-footer-link">
                  Native interactivity
                </a>
                <a href="/docs/store" className="b-footer-link">
                  State — the store
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
                <a href="/docs/rendering" className="b-footer-link">
                  Rendering
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
