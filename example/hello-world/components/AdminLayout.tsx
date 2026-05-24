import { Outlet } from '../../../runtime/index.ts'

export default function AdminLayout() {
  return (
    <div data-testid="AdminLayout">
      <nav data-testid="admin-nav">
        <a href="/admin">Dashboard</a>
        <a href="/admin/users">Users</a>
      </nav>
      <main>
        <Outlet />
      </main>
    </div>
  )
}
