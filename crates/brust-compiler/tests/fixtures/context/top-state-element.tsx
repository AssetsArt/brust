import { useState } from 'react'
import { icons } from './lib/els'

export default function Page() {
  const [s] = useState(icons.home)
  return <section>{s}</section>
}
