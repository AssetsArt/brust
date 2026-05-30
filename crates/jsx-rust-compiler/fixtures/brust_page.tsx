import { BrustPage, Island } from 'brustjs'
import Counter from '../components/Counter'

export default function Home({
  clientProps,
  serverProps,
}: {
  clientProps: { start: number; label: string }
  serverProps: { start: number; label: string }
}) {
  return (
    <BrustPage lang="en" className="dark" bodyClassName="brust-body" title="Built to Brust">
      <main className="brust-container">
        <h1 className="brust-title">Hello</h1>
        <Island component={Counter} props={clientProps} hydrate="load" />
        <Island component={Counter} props={serverProps} ssr hydrate="load" />
      </main>
    </BrustPage>
  )
}
