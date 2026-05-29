import { Suspense } from 'react'
import Layout from '../components/Layout'
import Bio from '../components/Bio'
import type { RouteContext } from '../../../runtime/routes.ts'

/** Stand-in for a real server-side fetch (DB call, HTTP fetch, etc.). */
function fetchBio(user: string): Promise<string> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(`${user} loves Brust. Bio fetched server-side after 150ms.`), 150)
  })
}

/** Async-data-component pattern (React 18 stable): the page itself is
 * synchronous so the shell ships immediately. The bio is fetched as a
 * Promise and handed to a child that suspends server-side — React's
 * `renderToPipeableStream` parks at the `<Suspense>` boundary, ships
 * the fallback in the first chunk, then streams the resolved markup
 * in a follow-up chunk when the Promise settles.
 *
 * (Top-level `async function Component` returning a Promise is React
 * Server Components territory and isn't supported by stable React 18's
 * stream renderer — it would throw "Objects are not valid as a React
 * child". The supported way to do server-side `await` is to chain it
 * through a Promise + Suspense the way we do here.) */
export default function Profile({ params }: RouteContext<{ user: string }>) {
  const greeting = `Profile: ${params.user}`
  return (
    <Layout title={greeting}>
      <h1>{greeting}</h1>
      <p>
        This page renders synchronously; the heading + this paragraph ship as the shell. The bio
        below uses a server-side fetch wrapped in
        <code> &lt;Suspense&gt;</code>, so the page doesn't wait for it — the fallback ships in the
        shell and the resolved markup streams in as a separate chunk ~150 ms later.
      </p>
      <Suspense
        fallback={
          <p data-testid="bio-fallback" className="text-gray-500 italic">
            loading bio...
          </p>
        }
      >
        <Bio promise={fetchBio(params.user)} />
      </Suspense>
    </Layout>
  )
}
