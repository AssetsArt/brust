import { Outlet } from '@brust/core/routes'
import Clock from './Clock'
import Count from './Count'

export default function B() {
  return (
    <section data-layout="B">
      <Count name="B" />
      <Clock name="B-island" />
      <Outlet />
    </section>
  )
}
