// Router-level native layout (Approach a: nested routes + <Outlet/>). Written
// ONCE and nested as the parent of every page route in routes.tsx. The synth
// wrapper the compiler builds is `<AppLayout native><Leaf native/></AppLayout>`.
// The chrome data it renders (title / crumb / teamProps / mode) comes from the
// MERGED LOADER CONTEXT: each leaf loader returns those fields and the
// chain-loader merge folds them into one flat jinja context; the names below are
// destructured so the native compiler resolves them as member-paths.
//
// MUST stay single-return with NO local bindings above it — a local `const`
// would make the compiler soft-fall-back to an SSR component (no <html> shell).
// AppLayout owns the single <main> (leaves are fragments in the <Outlet/> slot).
import { GitFork } from 'lucide-react'
import { BrustPage, Island, Outlet } from 'brustjs'
import type { TeamMember } from '../lib/types'
import NavLink from './NavLink'
import NavPreloader from './NavPreloader'
import TeamBuilder from './TeamBuilder'
import ThemeToggle from './ThemeToggle'

export default function AppLayout({
  title,
  teamProps,
  mode,
  themeLabel,
}: {
  title: string
  teamProps: { teamInitial: TeamMember[] }
  mode: 'dark' | 'light'
  themeLabel: string
}) {
  return (
    <BrustPage
      lang="en"
      data-mode={mode}
      title={title}
      head={[{ tag: 'link', rel: 'icon', href: '/favicon.svg' }]}
    >
      <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
        <header className="sticky top-0 z-50 border-b border-slate-200 bg-white/80 backdrop-blur-md dark:border-slate-800 dark:bg-slate-950/80">
          <nav className="mx-auto flex h-16 max-w-6xl items-center gap-2 px-4">
            <a href="/" className="mr-2 flex items-center gap-2 no-underline">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-500 text-sm font-extrabold text-white">
                P
              </span>
              <span className="text-base font-extrabold tracking-tight text-slate-900 dark:text-white">
                PokéDex
              </span>
            </a>
            <NavLink native href="/" label="Home" />
            <NavLink native href="/pokedex" label="Pokédex" />
            <NavLink native href="/type-chart" label="Type chart" />
            <div className="ml-auto flex items-center gap-2">
              <ThemeToggle native themeLabel={themeLabel} />
              {/* Team dock opens via the TeamBuilder island's own floating trigger
                  (the island owns its open state). A navbar button here would be a
                  dead affordance — cross-chunk toggle wiring is out of scope. */}
            </div>
          </nav>
        </header>

        <main className="mx-auto max-w-6xl px-4 py-8">
          <div className="container">
            <Outlet />
          </div>
        </main>

        <footer className="flex items-center justify-center gap-3 border-t border-slate-200 py-6 text-center text-xs text-slate-400 dark:border-slate-800">
          <span>Built with brust · data from PokeAPI</span>
          <a
            href="https://github.com/AssetsArt/brust"
            className="inline-flex items-center text-slate-400 transition-colors hover:text-slate-600 dark:hover:text-slate-200"
            aria-label="brust on GitHub"
          >
            <GitFork size={16} />
          </a>
        </footer>

        <Island
          component={TeamBuilder}
          props={teamProps}
          ssr
          hydrate="load"
          isr={{ key: 'TeamBuilderDock', tags: ['team'] }}
        />
        <Island component={NavPreloader} hydrate="load" />
      </div>
    </BrustPage>
  )
}
