import { Outlet } from '@brust/core/routes'
import Count from './Count'

/** The page renders a `<div>`: the parser closes the `<p>`, so the page's two comments are no longer siblings. */
export default function P() {
  return (
    <section data-layout="P">
      <Count name="P" />
      <p className="pw">
        <Outlet />
      </p>
    </section>
  )
}
