// Home — native landing (NO React; static JSX + two behavior components).
// Single return, no local bindings (native route root). The grainient WebGL
// hero is the page-load moment; everything below sits on theme tokens.
//
// The hero field is dark by design in BOTH themes (it IS the brand visual);
// text inside it uses explicit light colors over the `.hero-scrim`, not
// theme tokens. The features/footer use tokens and theme-flip normally.
//
// head: pre-paint FOUC killer — stamps data-theme from localStorage before
// first paint (static-literal text; duplicated in DocsLayout's shell because
// BrustPage head text must be a literal, not an imported const).
import { BrustPage } from 'brustjs'
import GrainientBackground from '../components/GrainientBackground'
import ThemeToggle from '../components/ThemeToggle'

export default function Home() {
  return (
    <BrustPage
      title="brust — native-first web framework"
      description="A Rust-core, Bun-runtime web framework with native-first rendering: JSX compiles to templates rendered in Rust, and JavaScript ships only where a page is interactive."
      head={[
        {
          tag: 'script',
          text: "(()=>{try{const t=localStorage.getItem('brust-docs-theme');if(t)document.documentElement.dataset.theme=t}catch{}})()",
        },
        { tag: 'link', rel: 'icon', href: '/favicon.ico' },
        { tag: 'link', rel: 'icon', type: 'image/png', href: '/favicon.png' },
      ]}
    >
      {/* ── Full-viewport grainient hero (dark in both themes) ─────────── */}
      <section className="relative isolate overflow-hidden bg-[#08050b]">
        <GrainientBackground native />
        <div className="hero-scrim" aria-hidden="true" />

        {/* glass pill navbar — the ONE glass use on the site */}
        <header className="absolute inset-x-0 top-5 z-10 flex justify-center px-4">
          <nav
            aria-label="Site"
            className="glass-pill flex items-center gap-1 rounded-full py-1.5 pr-1.5 pl-5 text-sm"
          >
            <a href="/" className="mr-3 text-base font-bold tracking-tight text-white no-underline">
              brust
            </a>
            <a
              href="/docs"
              className="flex h-10 items-center rounded-full px-3 text-white/80 no-underline transition-colors duration-150 hover:text-white"
            >
              Docs
            </a>
            <a
              href="https://github.com/AssetsArt/brust"
              className="flex h-10 items-center rounded-full px-3 text-white/80 no-underline transition-colors duration-150 hover:text-white"
            >
              GitHub
            </a>
            <span className="text-white">
              <ThemeToggle native />
            </span>
          </nav>
        </header>

        {/* hero copy */}
        <div className="relative mx-auto flex min-h-screen w-full max-w-4xl flex-col items-center justify-center px-6 py-28 text-center">
          <h1 className="text-hero font-bold tracking-tight text-brand-300">brust</h1>
          <p className="mt-5 max-w-2xl text-xl font-medium text-white">
            A Rust-core, Bun-runtime web framework with native-first rendering.
          </p>
          <p className="mt-3 max-w-xl text-base text-white/95">
            JSX compiles ahead of time to templates the Rust server renders directly. JavaScript
            ships only where a page is actually interactive.
          </p>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <a
              href="/docs/introduction"
              className="inline-flex h-11 items-center rounded-[var(--radius-control)] bg-accent px-6 font-semibold text-accent-fg no-underline transition-opacity duration-150 hover:opacity-90"
            >
              Get started
            </a>
            <a
              href="https://github.com/AssetsArt/brust"
              className="inline-flex h-11 items-center rounded-[var(--radius-control)] border border-white/30 px-6 font-medium text-white no-underline transition-colors duration-150 hover:border-white/60"
            >
              GitHub
            </a>
          </div>
        </div>
      </section>

      {/* ── Below the fold: asymmetric features (lead block + tight list) ── */}
      <section className="mx-auto w-full max-w-6xl px-6 py-20">
        <div className="grid gap-14 md:grid-cols-[1.1fr_1fr] md:gap-20">
          {/* lead: native-first rendering, with the measured number */}
          <div>
            <h2 className="text-2xl font-bold">Native-first rendering</h2>
            <p className="mt-4 max-w-[52ch] text-fg-muted">
              Most routes never run JavaScript to produce HTML. The compiler lowers your JSX to a
              template at build time and the Rust server renders it directly — React is reserved for
              the components that need it.
            </p>
            <p className="mt-7 text-4xl font-bold tabular-nums text-link">
              84,119 <span className="text-lg font-medium text-fg-muted">requests/sec</span>
            </p>
            <p className="mt-2 max-w-[52ch] text-sm text-fg-muted">
              Compiled native route, versus 28,938 for the same server rendering React — about 2.9×
              (bench/RESULTS.md: oha, 120 connections, Bun 1.4, darwin/arm64).
            </p>
          </div>

          {/* tight two-column list — varied rhythm, not cards */}
          <dl className="grid content-start gap-x-8 gap-y-7 sm:grid-cols-2">
            <div>
              <dt className="font-semibold">Islands</dt>
              <dd className="mt-1 text-sm leading-relaxed text-fg-muted">
                Hydrate one component, not the page. React mounts only inside explicit island hosts.
              </dd>
            </div>
            <div>
              <dt className="font-semibold">Markdown pages + SSG</dt>
              <dd className="mt-1 text-sm leading-relaxed text-fg-muted">
                Drop .md files in a folder for routed pages with nav — and a fully static build.
                This site is one.
              </dd>
            </div>
            <div>
              <dt className="font-semibold">Typed actions</dt>
              <dd className="mt-1 text-sm leading-relaxed text-fg-muted">
                Server functions with end-to-end types; the treaty client calls them like local
                code.
              </dd>
            </div>
            <div>
              <dt className="font-semibold">Isomorphic store</dt>
              <dd className="mt-1 text-sm leading-relaxed text-fg-muted">
                Signals that render on the server and stay reactive in the browser — one API for
                both.
              </dd>
            </div>
            <div>
              <dt className="font-semibold">MCP for agents</dt>
              <dd className="mt-1 text-sm leading-relaxed text-fg-muted">
                Actions double as MCP tools and loaders as resources, served at /_brust/mcp.
              </dd>
            </div>
          </dl>
        </div>
      </section>

      {/* ── Footer ─────────────────────────────────────────────────────── */}
      <footer className="border-t border-line">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-8 text-sm text-fg-muted">
          <p>MIT licensed.</p>
          <a
            href="https://github.com/AssetsArt/brust"
            className="text-link no-underline transition-colors duration-150 hover:underline"
          >
            GitHub
          </a>
        </div>
      </footer>
    </BrustPage>
  )
}
