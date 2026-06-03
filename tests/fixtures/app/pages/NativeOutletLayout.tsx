import { BrustPage, Outlet } from 'brustjs'

// T4 — native <Outlet> nested-route coverage. This is the PARENT layout of a
// native chain. It returns a <BrustPage> shell (framework owns <html>/<head>/
// <title>) with some chrome (<nav>) and a <main><Outlet/></main>. The leaf
// fragment is composed into the <Outlet/> slot at build time (T2's synth
// wrapper + T1's <Outlet/>→ChildrenSlot lowering).
//
// `section` comes from THIS node's loader (the parent loader). Rendering it in
// the <nav> proves parent-chain loader data reaches the composed template
// (T3's top-down merge). `title` flows into <title> via BrustPage.
export default function NativeOutletLayout({
  title,
  section,
}: {
  title: string
  section: string
}) {
  return (
    <BrustPage title={title}>
      <nav className="chrome">section: {section}</nav>
      <main>
        <Outlet />
      </main>
    </BrustPage>
  )
}
