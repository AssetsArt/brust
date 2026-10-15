// F234: a child that reads a defaulted prop directly. Its parent links it (x-props-bind), so the value can turn
// `undefined` on the client, and the default applies again as in React.
export default function Show({ v = 'dflt', user }: { v?: string; user?: { name: string } }) {
  return (
    <i data-testid="show">
      {v} {user ? user.name : 'nobody'}
    </i>
  )
}
