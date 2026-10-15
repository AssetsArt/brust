import { useState } from 'react'
import { icons } from './ctxlib/els'

export default function Page() {
  const [s] = useState(icons.home)
  return <section>{s}</section>
}
