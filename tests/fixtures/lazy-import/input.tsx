import { lazy, Suspense } from 'react'
const Panel = lazy(() => import('./panel'))
export default function App({ open }: { open: boolean }) {
  return <Suspense fallback={<p>…</p>}>{open && <Panel />}</Suspense>
}
