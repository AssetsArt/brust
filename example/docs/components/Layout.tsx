// Router-level NATIVE layout — written ONCE, nested as the parent of every /docs/*
// page. Single-return, NO local bindings above the JSX: the chrome destructures
// the merged leaf-loader context as member-paths (title/mode/nav/version/repo +
// prev/next pager fields). The grouped sidebar renders nav.map → nav.links.map
// (native x-for SSR); each link's active class is precomputed server-side
// (navFor) so the highlight ships as static HTML with zero JS. Three React
// islands hang off the shell: the ⌘K SearchPalette, the mobile drawer, and the
// scroll-spy TOC rail. The native SearchTrigger / ThemeToggle are react-free.
import { ArrowRight, GitFork, Zap } from 'lucide-react'
import { BrustPage, Island, Outlet } from 'brustjs'
import MobileNav from './MobileNav.island'
import SearchPalette from './SearchPalette.island'
import SearchTrigger from './SearchTrigger'
import ThemeToggle from './ThemeToggle'
import Toc from './Toc.island'
import type { NavSectionView } from '../lib/nav'

export default function Layout({
  title,
  mode,
  nav,
  version,
  repo,
  prevHref,
  prevTitle,
  prevCls,
  nextHref,
  nextTitle,
  nextCls,
}: {
  title: string
  mode: 'dark' | 'light'
  nav: NavSectionView[]
  version: string
  repo: string
  prevHref: string
  prevTitle: string
  prevCls: string
  nextHref: string
  nextTitle: string
  nextCls: string
}) {
  return (
    <BrustPage lang="en" data-mode={mode} title={title}>
      <div className="b-canvas min-h-screen">
        <header className="b-topbar">
          <Island component={MobileNav} hydrate="load" />
          <a href="/" className="flex items-center gap-2.5" aria-label="brust home">
            <span className="b-logo-mark grid h-8 w-8 place-items-center rounded-xl">
              <Zap size={17} />
            </span>
            <span className="b-wordmark text-base font-extrabold tracking-tight">brust</span>
            <span className="b-badge hidden items-center rounded-md px-1.5 py-0.5 font-mono text-[11px] font-semibold sm:inline-flex">
              docs
            </span>
          </a>
          <div className="flex flex-1 justify-center px-2">
            <SearchTrigger native />
          </div>
          <div className="flex items-center gap-1">
            <ThemeToggle native />
            <a
              href={repo}
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

        <div className="mx-auto flex max-w-6xl gap-8 px-4">
          <aside className="b-sidebar sticky top-[60px] hidden h-[calc(100vh-60px)] w-60 shrink-0 overflow-y-auto lg:block">
            <a href="/" className="b-overview">
              <Zap size={15} /> Overview
            </a>
            {nav.map((section) => (
              <div key={section.title} className="b-nav-group">
                <p className="b-nav-group__label">{section.title}</p>
                {section.links.map((link) => (
                  <a key={link.href} href={link.href} className={link.cls}>
                    <span className={link.railCls}></span>
                    {link.label}
                  </a>
                ))}
              </div>
            ))}
          </aside>

          <main className="min-w-0 flex-1 py-10">
            <div className="mx-auto max-w-3xl">
              <Outlet />
              <nav className="b-pager">
                <a href={prevHref} className={prevCls}>
                  <span className="b-pager__dir">← Previous</span>
                  <span className="b-pager__title">{prevTitle}</span>
                </a>
                <a href={nextHref} className={nextCls}>
                  <span className="b-pager__dir">Next →</span>
                  <span className="b-pager__title">{nextTitle}</span>
                </a>
              </nav>
            </div>
          </main>

          <aside className="sticky top-[76px] hidden h-[calc(100vh-76px)] w-56 shrink-0 overflow-y-auto py-10 xl:block">
            <Island component={Toc} hydrate="load" />
          </aside>
        </div>

        <footer className="b-footer">
          <div className="mx-auto max-w-6xl px-6 py-14">
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
