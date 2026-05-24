import type { RouteContext } from '../../../runtime/routes.ts'

export default function AdminUserDetail({ params }: RouteContext<{ id: string }>) {
  return (
    <section data-testid="AdminUserDetail">
      <h1>UserDetail</h1>
      <p>id={params.id}</p>
    </section>
  )
}
