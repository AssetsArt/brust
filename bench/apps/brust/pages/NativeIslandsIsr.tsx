import { Island } from '../../../../runtime/index.ts'
import Counter from '../../_shared/Counter'

/** Native (jinja) route with an ISR-CACHED server island — the
 * `/native-islands-isr` probe. Identical shape to `/native-islands` (one
 * client-only island + one ssr island), EXCEPT the ssr island carries an `isr`
 * attr: with a stable `key`, its `renderToString` runs ONCE, then every request
 * serves the frozen {html,props} pair from the Rust-side cache. The delta vs
 * `/native-islands` ≈ the per-request renderToString cost the ISR cache removes. */
export default function NativeIslandsIsr({
  greeting,
  clientProps,
  serverProps,
  cacheKey,
  cacheTags,
}: {
  greeting: string
  clientProps: { start: number; label: string }
  serverProps: { start: number; label: string }
  cacheKey: string
  cacheTags: string[]
}) {
  return (
    <div>
      <h1>{greeting}</h1>
      <Island component={Counter} props={clientProps} hydrate="load" />
      <Island
        component={Counter}
        props={serverProps}
        ssr
        hydrate="load"
        isr={{ key: cacheKey, tags: cacheTags }}
      />
    </div>
  )
}
