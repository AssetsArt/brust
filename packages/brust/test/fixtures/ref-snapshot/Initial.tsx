import { useState } from 'react'

// F277 (Mellow F1): `initial` keeps the `label` this instance mounted with.
export default function Initial({ label, testid }: { label: string; testid: string }) {
  const [initial] = useState(label)
  return <p data-testid={testid}>{initial}</p>
}
