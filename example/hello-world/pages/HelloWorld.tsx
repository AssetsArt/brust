import { Island } from '../../../runtime/index.ts'
import Layout from '../components/Layout'
import Counter from '../components/Counter'
import type { RouteContext } from '../../../runtime/routes.ts'

export default function HelloWorld({ workerId }: RouteContext) {
  return (
    <Layout title="Home">
      <h1>Hello from Brust</h1>
      <p>
        Rendered on <code>worker_id={workerId ?? 0}</code> and shipped as
        a single chunk with <code>Content-Length</code> (no streaming
        needed — no <code>&lt;Suspense&gt;</code> in this tree).
      </p>
      <p>
        The counter below is a client-hydrated island: only that subtree
        boots React in the browser. Everything else stays static HTML.
      </p>
      <Island
        component={Counter}
        props={{ start: 0, label: 'clicks' }}
        hydrate="load"
      />
    </Layout>
  )
}
