// The docs shell (canon docs page): sidebar with the current page, breadcrumb, the page through <Outlet/>, an
// "Edit this page" link, the prev/next pager, and the "On this page" list. docsLayoutLoader derives everything from
// the request path through lib/nav.ts; a page loader adds `toc` (its step headings) and may override `title`.
import { Fragment } from 'react'
import { type LoaderCtx, notFound, Outlet, type Verdict } from '@brust/core/routes'
import { type DocsNavData, docsNav, type PagerLink, type SideGroup, type TocItem } from '../../lib/nav'
import Toc from './Toc'

// The sidebar link: the page being read is marked by aria-current. The transition is motion-safe, as the rest of the site's.
const SIDE_LINK =
  '-ml-[.7rem] block rounded-[4px] px-[.7rem] py-[.22rem] text-ink-2 no-underline hover:bg-sheet hover:text-ink aria-[current=page]:bg-sheet aria-[current=page]:font-semibold aria-[current=page]:text-ink aria-[current=page]:outline aria-[current=page]:outline-1 aria-[current=page]:outline-rule motion-safe:[transition:background_.15s,color_.15s,border-color_.15s]'
const PAGER_LINK =
  'grid gap-[.1rem] rounded-[2px] border border-rule bg-sheet px-4 py-[.8rem] text-ink no-underline motion-safe:[transition:background_.15s,color_.15s,border-color_.15s] motion-safe:hover:border-ink'

export async function docsLayoutLoader({ path }: LoaderCtx): Promise<DocsNavData | Verdict> {
  return docsNav(path) ?? notFound({})
}

export default function DocsLayout({
  crumb,
  side,
  prev,
  next,
  editUrl,
  toc,
}: {
  crumb: string
  side: SideGroup[]
  prev?: PagerLink
  next?: PagerLink
  editUrl: string
  toc: TocItem[]
}) {
  return (
    <div className="mx-auto grid max-w-[1280px] grid-cols-[250px_minmax(0,1fr)_210px] gap-12 border-t border-rule px-4 max-wide:grid-cols-1 max-wide:gap-0">
      <nav
        className="sticky top-[calc(env(safe-area-inset-top,0px)+40px)] max-h-[calc(100vh-40px)] self-start overflow-y-auto py-8 text-[14.5px] max-wide:static max-wide:flex max-wide:max-h-none max-wide:flex-wrap max-wide:gap-x-4 max-wide:gap-y-[.1rem] max-wide:pb-0"
        aria-label="Docs"
      >
        {side.map((g) => (
          <Fragment key={g.group}>
            <h4 className="mb-[.35rem] mt-[1.4rem] font-display text-[13px] font-[750] text-ink first:mt-0 max-wide:basis-full">{g.group}</h4>
            {g.items.map((i) => (
              <a key={i.href} className={SIDE_LINK} href={i.href} aria-current={i.current ? 'page' : undefined}>
                {i.title}
              </a>
            ))}
          </Fragment>
        ))}
      </nav>
      <article className="doc grid min-w-0 content-start gap-[1.1rem] pb-14 pt-9">
        <div className="font-mono text-[13px] text-ink-2">{crumb}</div>
        <Outlet />
        <div className="mt-6 flex gap-6 border-t border-rule pt-4 text-[13.5px] text-ink-2">
          <a href={editUrl}>Edit this page on GitHub</a>
        </div>
        <nav className="grid grid-cols-2 gap-4" aria-label="Pages">
          {prev ? (
            <a className={PAGER_LINK} href={prev.href}>
              <span className="text-[12.5px] text-ink-2">Previous</span>
              <b className="font-semibold">{prev.title}</b>
            </a>
          ) : (
            <span />
          )}
          {next ? (
            <a className={`${PAGER_LINK} text-right`} href={next.href}>
              <span className="text-[12.5px] text-ink-2">Next</span>
              <b className="font-semibold">{next.title}</b>
            </a>
          ) : (
            <span />
          )}
        </nav>
      </article>
      <Toc items={toc} />
    </div>
  )
}
