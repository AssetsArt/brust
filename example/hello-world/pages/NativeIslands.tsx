import { Island } from '../../../runtime/index.ts'
import Counter from '../components/Counter'

/** Sub-project J / Phase A3 — islands on a NATIVE (jinja) route.
 *
 * This whole page is a static shell compiled to `.brust/jinja/NativeIslands.jinja`
 * and rendered Rust-side via minijinja (no React for the shell). The two
 * counters are islands that boot React only in their own subtree.
 *
 * Two things differ from the React-path island page (HelloWorld):
 *  - No `<Layout>` (or any custom component): the native compiler only emits
 *    host elements + `<Island>`. The shell is plain HTML.
 *  - Island `props` is a single PATH into the loader's return value
 *    (`props={clientProps}`), not an object literal — object-literal props are
 *    a v1 Non-goal on the native path.
 *
 * The two islands reuse the same `Counter` component but need DISTINCT ids
 * (the compiler rejects duplicate island ids on one page), so `island.config.ts`
 * maps `ClientCounter` and `ServerCounter` to `Counter.tsx`.
 */
export default function NativeIslands({
  greeting,
  clientProps,
  serverProps,
}: {
  greeting: string
  clientProps: { start: number; label: string }
  serverProps: { start: number; label: string }
}) {
  return (
    <div>
      <h1>{greeting}</h1>
      <p>
        Static jinja shell, rendered Rust-side. The two counters below are islands — only their
        subtrees boot React in the browser.
      </p>

      <h2>Client-only island</h2>
      <p>
        Empty mount (<code>data-brust-csr</code>) until JS boots, then
        <code>createRoot</code> renders it. No server markup, so it flashes empty and is invisible
        to no-JS clients.
      </p>
      <Island component={Counter} id="ClientCounter" props={clientProps} hydrate="load" />

      <h2>Server island (ssr)</h2>
      <p>
        The worker <code>renderToString</code>s this counter during the loader crossing, so its
        markup ships in the HTML (no layout shift, SEO-visible) and the client{' '}
        <code>hydrateRoot</code>s it.
      </p>
      <Island component={Counter} id="ServerCounter" props={serverProps} ssr hydrate="load" />
    </div>
  )
}
