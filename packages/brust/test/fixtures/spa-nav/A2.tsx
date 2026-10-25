import { Outlet } from '@brust/core/routes'
import Count from './Count'

export default function A2() {
  return (
    <div data-layout="A2">
      <Count name="A2" />
      <Outlet />
    </div>
  )
}
