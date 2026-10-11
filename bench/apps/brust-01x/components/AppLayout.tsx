import { BrustPage, Outlet } from '../../../../runtime/index.ts'
export default function AppLayout({ title }: { title: string }) {
  return (
    <BrustPage lang="en" title={title}>
      <header><nav><a href="/types">Types</a><a href="/dex">Pokédex</a><a href="/team">Team</a></nav></header>
      <main><Outlet /></main>
      <footer>bench · brust 0.1.x</footer>
    </BrustPage>
  )
}
