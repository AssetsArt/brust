// F234: a native child that reads only a member of a defaulted object prop (`user.name`): the seed is the members it
// reads, and an omitted `user` must stay absent (not `{}`) so the default applies on the client too.
import { useState } from 'react'

export default function Who({ user = { name: 'dflt' } }: { user?: { name: string } }) {
  const [n, setN] = useState(0)
  return (
    <b data-testid="who" onClick={() => setN(n + 1)}>
      {user.name} {n}
    </b>
  )
}
