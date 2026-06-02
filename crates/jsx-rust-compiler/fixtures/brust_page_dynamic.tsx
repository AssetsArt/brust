import { BrustPage } from 'brustjs'

export default function Home({
  d,
}: {
  d: { title: string; desc: string; lang: string }
}) {
  return (
    <BrustPage title={d.title} description={d.desc} lang={d.lang}>
      <main className="brust-container">
        <h1 className="brust-title">{d.title}</h1>
      </main>
    </BrustPage>
  )
}
