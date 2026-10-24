// F404: the filed shape. `children` is markup the caller passes, so a state seeded from it cannot be native.
import { useState } from 'react'

export default function Seeded({ children }: { children?: React.ReactNode }) {
  const [c] = useState(children)
  return <div id="seeded">{c}</div>
}
