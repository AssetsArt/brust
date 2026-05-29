import { Island } from '../../../../runtime/index.ts'
import Counter from '../../_shared/Counter'

/** Native (jinja) route with two islands — the `/native-islands` probe.
 * Mirror of the example demo page, kept here so the bench is self-contained.
 * Both islands reuse the same `Counter` component (one `Counter.js` chunk);
 * they differ only by source-order instance + the `ssr` flag — no id, no
 * config. */
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
      <Island component={Counter} props={clientProps} hydrate="load" />
      <Island component={Counter} props={serverProps} ssr hydrate="load" />
    </div>
  )
}
