import { Island } from '../../../../runtime/index.ts'
import Counter from '../../_shared/Counter'

/** Native (jinja) route with two islands — the `/native-islands` probe.
 * Mirror of the example demo page, kept here so the bench is self-contained.
 * Distinct ids (ClientCounter / ServerCounter) because the native compiler
 * rejects duplicate island ids on one page. */
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
      <Island component={Counter} id="ClientCounter" props={clientProps} hydrate="load" />
      <Island component={Counter} id="ServerCounter" props={serverProps} ssr hydrate="load" />
    </div>
  )
}
