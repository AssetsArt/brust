// components/AppLayout.tsx — the document (S9): plain <html>, <Outlet/> for the leaf, TeamBuilder as a react child.
import { Outlet } from '@brust/core/routes'
import type { NavItem, TeamMember } from '../lib/types'
import NavLink from './NavLink'
import TeamBuilder from './TeamBuilder'
import ThemeToggle from './ThemeToggle'

export default function AppLayout(props: { title: string; mode: 'dark' | 'light'; nav: NavItem[]; teamInitial: TeamMember[] }) {
  return (
    <html lang="en" data-mode={props.mode}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title}</title>
        <link rel="icon" href="/public/favicon.svg" />
        <link rel="stylesheet" href="/public/app.css" />
      </head>
      <body className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
        <header className="sticky top-0 z-50 border-b border-slate-200 bg-white/80 dark:border-slate-800 dark:bg-slate-950/80">
          <nav className="mx-auto flex h-16 max-w-6xl items-center gap-2 px-4">
            <a href="/" className="mr-2 flex items-center gap-2 no-underline"><span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-500 text-sm font-extrabold text-white">P</span><span className="text-base font-extrabold">PokéDex</span></a>
            {props.nav.map((n) => <NavLink key={n.href} href={n.href} label={n.label} active={n.active} />)}
            <div className="ml-auto"><ThemeToggle mode={props.mode} /></div>
          </nav>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-8"><Outlet /></main>
        <footer className="border-t border-slate-200 py-6 text-center text-xs text-slate-400 dark:border-slate-800">Built with brust · data: PokeAPI snapshot</footer>
        <TeamBuilder teamInitial={props.teamInitial} />
      </body>
    </html>
  )
}
