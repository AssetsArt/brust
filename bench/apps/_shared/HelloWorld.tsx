import { Island } from '../../../runtime/index.ts'
import Layout from './Layout'
import Counter from './Counter'
import type { RouteContext } from '../../../runtime/routes.ts'

// Shared React-SSR page for the `/` probe. The three bench scenarios
// (brust route / bun-serve / elysia) all render THIS component via
// renderToString, so the React-SSR comparison is apples-to-apples. Kept
// byte-identical to the example's HelloWorld.
export default function HelloWorld({ workerId }: RouteContext) {
  return (
    <Layout title="Home">
      <h1>Hello from Brust</h1>
      <p>
        Rendered on <code>{`worker_id=${workerId ?? 0}`}</code> and shipped as
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
