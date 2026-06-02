// React-path page for the isomorphic-store integration test (T8). Reads the
// `counter` store via useStore — during SSR this resolves the per-request store
// instance seeded by the loader (routes.tsx). The rendered value lands in the
// initial HTML body; the framework also injects the seeded state as a
// <script data-brust-store="counter"> before </head> (buffering path).
import { useStore } from '../../../../runtime/index.ts'
import type { RouteContext } from '../../../../runtime/routes.ts'
import Layout from '../components/Layout'
import { counter } from '../stores/counter'

export default function StoreDemo(_props: RouteContext) {
  const snap = useStore(counter)
  return (
    <Layout title="Store demo">
      <h1>StoreDemo</h1>
      <p>
        counter value: <span data-testid="counter-value">{snap.value}</span>
      </p>
    </Layout>
  )
}
