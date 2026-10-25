import { Outlet } from '@brust/core/routes'
import Count from './Count'

/** The page renders a `<div>`: the parser moves it out in front of the table and leaves the comments in it. */
export default function T() {
  return (
    <section data-layout="T">
      <Count name="T" />
      <table>
        <Outlet />
      </table>
    </section>
  )
}
