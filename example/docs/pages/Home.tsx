// Home — native landing (static JSX + behavior components + ONE React island).
// Single return, no local bindings (native route root). The grainient WebGL
// hero is the page-load moment; everything below sits on theme tokens.
//
// The pitch is UNIFIED: like a chip with unified memory, Brust gives server
// templates, React islands, and native behaviors one shared store — and the
// page proves it live (UnifiedIsland + UnifiedNative + UnifiedStoreNode all
// on `docs.unified`, joined by CSS-animated SVG connector pulses). The stack
// itself is deliberately NOT the pitch; it gets exactly one quiet
// "under the hood" line at the end of the features section.
//
// The hero field is dark by design in BOTH themes (it IS the brand visual);
// text inside it uses explicit light colors over the `.hero-scrim`, not
// theme tokens. The demo/features/footer use tokens and theme-flip normally.
//
// head: pre-paint FOUC killer — stamps data-theme from localStorage before
// first paint (static-literal text; duplicated in DocsLayout's shell because
// BrustPage head text must be a literal, not an imported const).
import { BrustPage, Island } from 'brustjs'
import GrainientBackground from '../components/GrainientBackground'
import ThemeToggle from '../components/ThemeToggle'
import UnifiedIsland from '../components/UnifiedIsland'
import UnifiedNative from '../components/UnifiedNative'
import UnifiedStoreNode from '../components/UnifiedStoreNode'

export default function Home() {
  return (
    <BrustPage
      title="Brust — one core, every paradigm"
      description="Server pages, React islands, and native interactions share one live store. Brust compiles pages ahead of time and ships zero JavaScript until you add interactivity."
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
          <p className="mt-5 max-w-2xl text-xl font-medium text-white">One core. Every paradigm.</p>
          <p className="mt-3 max-w-xl text-base text-white/95">
            Server pages, React islands, and native interactions all read and write one shared
            store. Pages ship zero JavaScript until you add interactivity — and then only exactly
            where you put it.
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

      {/* ── Unified store: the live proof ──────────────────────────────────
          SoC-style diagram: React island (left) ↔ one store (center) ↔
          native zero-React component (right). The connector SVGs carry
          CSS-only traveling pulses (`.connector-pulse`, app.css); both sides
          flow INTO the store node (right side reversed). On small screens
          the diagram stacks and the connectors turn vertical. */}
      <section className="mx-auto w-full max-w-6xl px-6 pt-24 pb-8">
        <div className="max-w-2xl">
          <h2 className="text-2xl font-bold">One store. Every paradigm reads it live.</h2>
          <p className="mt-4 text-fg-muted">
            Brust is built like unified memory: a single state substrate that every kind of
            component addresses directly — no bridges, no event buses, no syncing two worlds. This
            demo is real. The left panel is hydrated React; the right panel ships zero React. Click
            either side and both move, through the store in the middle.
          </p>
        </div>

        <div className="mt-12 grid items-center gap-3 md:grid-cols-[1fr_3.5rem_auto_3.5rem_1fr] md:gap-0">
          {/* React island panel */}
          <div className="rounded-[var(--radius-card)] border border-line bg-surface p-6">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="font-semibold">React island</h3>
              <code className="text-sm text-fg-muted">useStore</code>
            </div>
            <p className="mt-1 text-sm text-fg-muted">
              A hydrated React component, subscribed through useStore.
            </p>
            <div className="mt-6 flex min-h-28 items-center justify-center">
              <Island component={UnifiedIsland} hydrate="load" />
            </div>
          </div>

          {/* connector: React ↔ store (pulses travel toward the store) */}
          <div aria-hidden="true">
            <svg aria-hidden="true" className="hidden h-2 w-full md:block">
              <line className="connector-base" x1="0" y1="50%" x2="100%" y2="50%" />
              <line className="connector-pulse" x1="0" y1="50%" x2="100%" y2="50%" />
            </svg>
            <svg aria-hidden="true" className="mx-auto block h-12 w-2 md:hidden">
              <line className="connector-base" x1="50%" y1="0" x2="50%" y2="100%" />
              <line className="connector-pulse" x1="50%" y1="0" x2="50%" y2="100%" />
            </svg>
          </div>

          {/* the unified store node */}
          <div className="justify-self-center">
            <UnifiedStoreNode native />
          </div>

          {/* connector: store ↔ native (reversed — also flows into the store) */}
          <div aria-hidden="true">
            <svg aria-hidden="true" className="hidden h-2 w-full md:block">
              <line className="connector-base" x1="0" y1="50%" x2="100%" y2="50%" />
              <line className="connector-pulse connector-rev" x1="0" y1="50%" x2="100%" y2="50%" />
            </svg>
            <svg aria-hidden="true" className="mx-auto block h-12 w-2 md:hidden">
              <line className="connector-base" x1="50%" y1="0" x2="50%" y2="100%" />
              <line className="connector-pulse connector-rev" x1="50%" y1="0" x2="50%" y2="100%" />
            </svg>
          </div>

          {/* native panel */}
          <div className="rounded-[var(--radius-card)] border border-line bg-surface p-6">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="font-semibold">Native component</h3>
              <code className="text-sm text-fg-muted">zero React</code>
            </div>
            <p className="mt-1 text-sm text-fg-muted">
              A compiled template with a small signal behavior — no React in its bundle.
            </p>
            <div className="mt-6 flex min-h-28 items-center justify-center">
              <UnifiedNative native />
            </div>
          </div>
        </div>

        <p className="mt-8 text-center text-sm text-fg-muted">
          One <code>defineStore('docs.unified')</code> — both sides write it, all three read it.
        </p>
      </section>

      {/* ── Features: asymmetric (lead block + tight list) ─────────────── */}
      <section className="mx-auto w-full max-w-6xl px-6 py-20">
        <div className="grid gap-14 md:grid-cols-[1.1fr_1fr] md:gap-20">
          {/* lead: zero JS by default, with the measured number as the outcome */}
          <div>
            <h2 className="text-2xl font-bold">Zero JavaScript by default</h2>
            <p className="mt-4 max-w-[52ch] text-fg-muted">
              Pages compile ahead of time and are served as plain HTML — no hydration pass, no
              framework runtime in the response. JavaScript ships only where you place an island or
              a behavior.
            </p>
            <p className="mt-7 text-4xl font-bold tabular-nums text-link">
              84,119 <span className="text-lg font-medium text-fg-muted">requests/sec</span>
            </p>
            <p className="mt-2 max-w-[52ch] text-sm text-fg-muted">
              One compiled page under load, versus 28,938 for the same page rendered through a
              JavaScript pipeline — about 2.9× (bench/RESULTS.md: oha, 120 connections,
              darwin/arm64).
            </p>
          </div>

          {/* tight two-column list — varied rhythm, not cards */}
          <dl className="grid content-start gap-x-8 gap-y-7 sm:grid-cols-2">
            <div>
              <dt className="font-semibold">React islands</dt>
              <dd className="mt-1 text-sm leading-relaxed text-fg-muted">
                Hydrate one component, not the page. React mounts only inside the island hosts you
                place.
              </dd>
            </div>
            <div>
              <dt className="font-semibold">Native interactivity</dt>
              <dd className="mt-1 text-sm leading-relaxed text-fg-muted">
                Counters, toggles, live text — small signal-driven behaviors that ship no React at
                all.
              </dd>
            </div>
            <div>
              <dt className="font-semibold">One store across all of it</dt>
              <dd className="mt-1 text-sm leading-relaxed text-fg-muted">
                defineStore resolves to a single instance, so islands and native components share
                state with no bridge code.
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
              <dt className="font-semibold">Markdown pages + SSG</dt>
              <dd className="mt-1 text-sm leading-relaxed text-fg-muted">
                Drop .md files in a folder for routed pages with nav — and a fully static build.
                This site is one.
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

        {/* the one quiet stack mention on the page */}
        <p className="mt-16 border-t border-line pt-6 text-sm text-fg-muted">
          Under the hood, Brust renders compiled templates in a Rust core on the Bun runtime — a
          detail you mostly never have to think about.
        </p>
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
