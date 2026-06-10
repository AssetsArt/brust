import { BrustPage, Outlet } from 'brustjs'

// Task 2.10 — native layout for the markdown-pages fixture (`mdRoutes` with
// `layout:`). Chained-mode contract: the LAYOUT owns the document shell
// (BrustPage → <html>/<head>) and the single <main> with <Outlet/>; each md
// leaf compiles to a bare <article data-brust-md-slot> fragment composed into
// the <Outlet/> at build time.
//
// Head metadata comes from the md leaf's generated loader, which returns
// `{ __md: { title, description } }` from the page's frontmatter — the layout
// threads it into BrustPage via plain member-path props (the only expression
// shape native templates allow).
export default function MdDocsLayout({
  __md,
}: {
  __md: { title?: string; description?: string }
}) {
  return (
    <BrustPage title={__md.title} description={__md.description}>
      <nav className="docs-chrome">docs fixture</nav>
      <main>
        <Outlet />
      </main>
    </BrustPage>
  )
}
