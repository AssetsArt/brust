// F230 case l: the layout imports the writer for its effect.
import { Outlet } from '@brust/core/routes'
import './patch-l'
export default function Layout() {
  return (
    <section>
      <Outlet />
    </section>
  )
}
