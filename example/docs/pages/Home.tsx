// Home — native landing (static JSX + behavior components + ONE React island).
// Single return, no local bindings (native route root). Structure follows
// a typographic landing structure (huge centered hero + copy-able create
// command, blueprint guide lines, bento feature grid) at apple.com/macbook-pro
// pacing (one dominant idea per fold, generous clamp() vertical space) — in
// OUR color system: grainient hero, brand greens, dark default.
//
// The pitch is UNIFIED: like a chip with unified memory, Brust gives server
// templates, React islands, and native behaviors one shared store — and the
// page proves it live (UnifiedIsland + UnifiedNative + UnifiedStoreNode all
// on `docs.unified`). The store node is dressed as a CHIP (CSS pin strips)
// with elbowed circuit traces carrying CSS-animated pulses INTO it. The
// stack itself is deliberately NOT the pitch; it gets exactly one quiet
// "under the hood" line before the footer.
//
// The hero field is dark by design in BOTH themes (it IS the brand visual);
// text inside it uses explicit light colors over the `.hero-scrim`, not
// theme tokens. Everything below uses tokens and theme-flips normally; the
// blueprint guides (`.home-guides` / `.home-fold` / `.guide-mark`, app.css)
// are faint dashed hairlines in --line, sections-below-the-hero only.
//
// head: pre-paint FOUC killer — stamps data-theme from localStorage before
// first paint (static-literal text; duplicated in DocsLayout's shell because
// BrustPage head text must be a literal, not an imported const).
import { BrustPage, Island } from 'brustjs'
import CopyCommand from '../components/CopyCommand'
import GrainientBackground from '../components/GrainientBackground'
import ThemeToggle from '../components/ThemeToggle'
import UnifiedIsland from '../components/UnifiedIsland'
import UnifiedNative from '../components/UnifiedNative'
import UnifiedStoreNode from '../components/UnifiedStoreNode'

// `version` is supplied by the route loader (routes.tsx) from the brustjs
// package manifest — bound as a member path here, never hardcoded. A prop, not
// a local binding, so the native-route-root single-return rule still holds.
export default function Home({ version }: { version: string }) {
  return (
    <BrustPage
      title="Brust — the unified framework for the web"
      description="Server pages, React islands, and native interactions share one live store. Brust compiles pages ahead of time and ships zero JavaScript until you add interactivity."
      data-brust-view-transitions=""
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
      <section className="relative isolate overflow-hidden bg-[#201712]">
        <GrainientBackground native />
        <div className="hero-scrim" aria-hidden="true" />

        {/* glass pill navbar — the ONE glass use on the site */}
        <header className="absolute inset-x-0 top-5 z-10 flex justify-center px-4">
          <nav
            aria-label="Site"
            className="glass-pill flex items-center gap-1 rounded-full py-1.5 pr-1.5 pl-5 text-sm"
          >
            <a href="/" className="mr-3 text-base font-bold tracking-tight text-white no-underline">
              Brust
            </a>
            <a
              href="/docs"
              className="flex h-10 items-center rounded-full px-3 text-white/80 no-underline transition-colors duration-150 hover:text-white"
            >
              Docs
            </a>
            <a
              href="https://github.com/AssetsArt/brust"
              target="_blank"
              rel="noopener noreferrer"
              className="flex h-10 items-center rounded-full px-3 text-white/80 no-underline transition-colors duration-150 hover:text-white"
            >
              GitHub
            </a>
            <a
              href="https://www.npmjs.com/package/brustjs"
              target="_blank"
              rel="noopener noreferrer"
              className="flex h-10 items-center rounded-full px-3 text-white/80 no-underline transition-colors duration-150 hover:text-white"
            >
              Npm
            </a>
            <span className="text-white">
              <ThemeToggle native />
            </span>
          </nav>
        </header>

        {/* hero copy — huge centered headline, one
            short supporting line, two buttons, copy-able create command */}
        <div className="relative mx-auto flex min-h-screen w-full max-w-5xl flex-col items-center justify-center px-6 py-28 text-center">
          <h1 className="text-hero font-bold tracking-tight text-white">
            The unified framework for the web
          </h1>
          <p className="mt-6 max-w-2xl text-lg text-white/95">
            Brust serves compiled pages with zero JavaScript by default — and gives server
            templates, React islands, and native interactions one shared store the moment you add
            it.
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
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-11 items-center rounded-[var(--radius-control)] border border-white/30 px-6 font-medium text-white no-underline transition-colors duration-150 hover:border-white/60"
            >
              GitHub
            </a>
          </div>
          <div className="mt-8">
            <CopyCommand native />
          </div>
        </div>
      </section>

      {/* ── Blueprint guide container: every fold below the hero ───────── */}
      <div className="home-guides relative mx-auto w-full max-w-6xl">
        {/* ── Fold 1 · Powered by one core: the live chip demo ────────────
            SoC diagram: React island (left) ↔ chip-dressed store node
            (center) ↔ native zero-React component (right). The elbowed
            circuit traces carry CSS-only traveling pulses (`.connector-pulse`,
            app.css); both sides flow INTO the chip (right side reversed).
            On small screens the diagram stacks and the traces turn into
            straight vertical drops. */}
        <section className="home-fold relative px-6 py-[clamp(5rem,12vw,8.5rem)]">
          <span className="guide-mark guide-mark-l" aria-hidden="true" />
          <span className="guide-mark guide-mark-r" aria-hidden="true" />
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-bold sm:text-4xl">Powered by one core</h2>
            <p className="mt-5 text-lg text-fg-muted">
              Brust is built like unified memory: a single state substrate every kind of component
              addresses directly — no bridges, no event buses, no syncing two worlds. This demo is
              real. The left panel is hydrated React; the right panel ships zero React. Click either
              side and both move, through the chip in the middle.
            </p>
          </div>

          <div className="mt-16 grid items-center gap-3 md:grid-cols-[1fr_4.5rem_auto_4.5rem_1fr] md:gap-0">
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

            {/* circuit trace: React → chip (pulses travel toward the chip).
                Fixed-pixel elbow polylines inside the fixed 4.5rem column —
                lowercase attrs only (the compiler's SVG contract). */}
            <div aria-hidden="true">
              <svg aria-hidden="true" width="72" height="56" className="hidden md:block">
                <polyline className="connector-base" points="0,8 36,8 36,28 72,28" />
                <polyline className="connector-pulse" points="0,8 36,8 36,28 72,28" />
              </svg>
              <svg aria-hidden="true" className="mx-auto block h-12 w-2 md:hidden">
                <line className="connector-base" x1="50%" y1="0" x2="50%" y2="100%" />
                <line className="connector-pulse" x1="50%" y1="0" x2="50%" y2="100%" />
              </svg>
            </div>

            {/* the unified store, dressed as the chip (pin strips via
                .chip-frame pseudos + the two .chip-pins-x spans) */}
            <div className="justify-self-center">
              <div className="chip-frame">
                <span className="chip-pins-x -top-[9px]" aria-hidden="true" />
                <span className="chip-pins-x -bottom-[9px]" aria-hidden="true" />
                <UnifiedStoreNode native />
              </div>
            </div>

            {/* circuit trace: native → chip (reversed — also flows in) */}
            <div aria-hidden="true">
              <svg aria-hidden="true" width="72" height="56" className="hidden md:block">
                <polyline className="connector-base" points="0,28 36,28 36,48 72,48" />
                <polyline
                  className="connector-pulse connector-rev"
                  points="0,28 36,28 36,48 72,48"
                />
              </svg>
              <svg aria-hidden="true" className="mx-auto block h-12 w-2 md:hidden">
                <line className="connector-base" x1="50%" y1="0" x2="50%" y2="100%" />
                <line
                  className="connector-pulse connector-rev"
                  x1="50%"
                  y1="0"
                  x2="50%"
                  y2="100%"
                />
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

          <p className="mt-10 text-center text-sm text-fg-muted">
            One <code>defineStore('docs.unified')</code> — both sides write it, all three read it.
          </p>
        </section>

        {/* ── Fold 2 · Features bento (varied spans, ONE dark highlight) ── */}
        <section className="home-fold relative px-6 py-[clamp(5rem,12vw,8.5rem)]">
          <span className="guide-mark guide-mark-l" aria-hidden="true" />
          <span className="guide-mark guide-mark-r" aria-hidden="true" />
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-bold sm:text-4xl">Built in, not bolted on</h2>
            <p className="mt-5 text-lg text-fg-muted">
              Everything a content site or an app shell needs ships with the framework — each piece
              reading the same store, typed end to end.
            </p>
          </div>

          <div className="mt-14 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {/* lead card (2×2): native rendering, with the measured number.
                Every card is a LINK into its docs page (whole-card hit area;
                hover = brand border + title shift via group). */}
            <a
              href="/docs/rendering"
              className="group flex flex-col justify-between rounded-[var(--radius-card)] border border-line bg-surface p-7 text-fg no-underline transition-colors duration-150 hover:border-brand-300/60 sm:col-span-2 lg:row-span-2"
            >
              <div>
                <h3 className="text-lg font-semibold transition-colors duration-150 group-hover:text-link">
                  Native rendering
                </h3>
                <p className="mt-2 max-w-[46ch] text-sm leading-relaxed text-fg-muted">
                  Pages compile ahead of time and are served as plain HTML — no hydration pass, no
                  framework runtime in the response. JavaScript ships only where you place an island
                  or a behavior.
                </p>
              </div>
              <div className="mt-10">
                <p className="text-4xl font-bold tabular-nums text-link">
                  106,374 <span className="text-base font-medium text-fg-muted">requests/sec</span>
                </p>
                <p className="mt-2 max-w-[46ch] text-sm leading-relaxed text-fg-muted">
                  One compiled page under load, versus 44,448 for the same page rendered through a
                  JavaScript pipeline — about 2.4× (bench/RESULTS.md: oha, 120 connections, M1 Pro
                  10c, darwin/arm64).
                </p>
              </div>
            </a>

            <a
              href="/docs/rendering#islands"
              className="group rounded-[var(--radius-card)] border border-line bg-surface p-6 text-fg no-underline transition-colors duration-150 hover:border-brand-300/60"
            >
              <h3 className="font-semibold transition-colors duration-150 group-hover:text-link">
                React islands
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-fg-muted">
                Hydrate one component, not the page. React mounts only inside the island hosts you
                place.
              </p>
            </a>

            <a
              href="/docs/native-interactivity"
              className="group rounded-[var(--radius-card)] border border-line bg-surface p-6 text-fg no-underline transition-colors duration-150 hover:border-brand-300/60"
            >
              <h3 className="font-semibold transition-colors duration-150 group-hover:text-link">
                Native interactivity
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-fg-muted">
                Counters, toggles, live text — small signal-driven behaviors that ship no React at
                all.
              </p>
            </a>

            <a
              href="/docs/actions"
              className="group rounded-[var(--radius-card)] border border-line bg-surface p-6 text-fg no-underline transition-colors duration-150 hover:border-brand-300/60"
            >
              <h3 className="font-semibold transition-colors duration-150 group-hover:text-link">
                Typed actions end-to-end
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-fg-muted">
                Server functions with end-to-end types; the treaty client calls them like local
                code.
              </p>
            </a>

            <a
              href="/docs/markdown-pages"
              className="group rounded-[var(--radius-card)] border border-line bg-surface p-6 text-fg no-underline transition-colors duration-150 hover:border-brand-300/60"
            >
              <h3 className="font-semibold transition-colors duration-150 group-hover:text-link">
                Markdown pages + SSG
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-fg-muted">
                Drop .md files in a folder for routed pages with nav — and a fully static build.
                This site is one.
              </p>
            </a>

            <a
              href="/docs/store"
              className="group rounded-[var(--radius-card)] border border-line bg-surface p-6 text-fg no-underline transition-colors duration-150 hover:border-brand-300/60"
            >
              <h3 className="font-semibold transition-colors duration-150 group-hover:text-link">
                One store across paradigms
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-fg-muted">
                defineStore resolves to a single instance, so islands and native components share
                state with no bridge code.
              </p>
            </a>

            <a
              href="/docs/agents"
              className="group rounded-[var(--radius-card)] border border-line bg-surface p-6 text-fg no-underline transition-colors duration-150 hover:border-brand-300/60"
            >
              <h3 className="font-semibold transition-colors duration-150 group-hover:text-link">
                MCP for agents
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-fg-muted">
                Actions double as MCP tools and loaders as resources, served at /_brust/mcp.
              </p>
            </a>

            {/* the ONE dark highlight card (stays dark in both themes) */}
            <a
              href="https://github.com/AssetsArt/brust/releases"
              target="_blank"
              rel="noopener noreferrer"
              className="bento-highlight flex flex-col justify-between rounded-[var(--radius-card)] p-7 no-underline transition-colors duration-150 sm:col-span-2"
            >
              <div>
                <h3 className="text-lg font-semibold text-white">Brust {version}</h3>
                <p className="mt-2 text-sm leading-relaxed text-white/75">
                  What landed in the latest alpha — changes, fixes, and upgrade notes, straight from
                  the repository.
                </p>
              </div>
              <p className="mt-8 text-sm font-medium text-brand-300">Read the release notes →</p>
            </a>
          </div>
        </section>

        {/* ── Fold 3 · the one quiet stack mention on the page ──────────── */}
        <section className="home-fold relative px-6 py-12">
          <span className="guide-mark guide-mark-l" aria-hidden="true" />
          <span className="guide-mark guide-mark-r" aria-hidden="true" />
          <p className="mx-auto max-w-2xl text-center text-sm text-fg-muted">
            Under the hood, Brust renders compiled templates in a Rust core on the Bun runtime — a
            detail you mostly never have to think about.
          </p>
        </section>
      </div>

      {/* ── Footer ─────────────────────────────────────────────────────── */}
      <footer className="border-t border-line">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-8 text-sm text-fg-muted">
          <p>MIT licensed.</p>
          <div className="flex items-center gap-5">
            <a
              href="https://github.com/AssetsArt/brust"
              target="_blank"
              rel="noopener noreferrer"
              className="text-link no-underline transition-colors duration-150 hover:underline"
            >
              GitHub
            </a>
            <a
              href="https://www.npmjs.com/package/brustjs"
              target="_blank"
              rel="noopener noreferrer"
              className="text-link no-underline transition-colors duration-150 hover:underline"
            >
              Npm
            </a>
          </div>
        </div>
      </footer>
    </BrustPage>
  )
}
