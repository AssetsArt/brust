import { useState } from 'react'
import { USERS } from './data'
// a host whose own rows over module data read its prop: in a clone that prop follows the caller (S3), F325 keeps them
export default function Lister({ label, children }: { label: string; children?: React.ReactNode }) {
  const [n, setN] = useState(0)
  return (
    <div data-n={n} onClick={() => setN(n + 1)}>
      {children}
      <ul>{USERS.map((u) => <li key={u.name}>{label}</li>)}</ul>
    </div>
  )
}
