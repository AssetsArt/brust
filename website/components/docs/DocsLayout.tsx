// The docs shell (canon docs page): sidebar with the current page, breadcrumb, the page through <Outlet/>, an
// "Edit this page" link, the prev/next pager, and the "On this page" list. docsLayoutLoader derives everything from
// the request path through lib/nav.ts; a page loader adds `toc` (its step headings) and may override `title`.
import { Fragment } from 'react'
import { type LoaderCtx, notFound, Outlet, type Verdict } from '@brust/core/routes'
import { type DocsNavData, docsNav, type PagerLink, type SideGroup, type TocItem } from '../../lib/nav'
import Toc from './Toc'

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
    <div className="docs">
      <nav className="side" aria-label="Docs">
        {side.map((g) => (
          <Fragment key={g.group}>
            <h4>{g.group}</h4>
            {g.items.map((i) => (
              <a key={i.href} href={i.href} aria-current={i.current ? 'page' : undefined}>
                {i.title}
              </a>
            ))}
          </Fragment>
        ))}
      </nav>
      <article className="doc">
        <div className="crumbs">{crumb}</div>
        <Outlet />
        <div className="foot-meta">
          <a href={editUrl}>Edit this page on GitHub</a>
        </div>
        <nav className="pager" aria-label="Pages">
          {prev ? (
            <a href={prev.href}>
              <span>Previous</span>
              <b>{prev.title}</b>
            </a>
          ) : (
            <span />
          )}
          {next ? (
            <a className="next" href={next.href}>
              <span>Next</span>
              <b>{next.title}</b>
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
