import { Outlet } from '@brust/core/routes'

export default function Inner() {
  return (
    <main>
      <Outlet />
    </main>
  )
}
