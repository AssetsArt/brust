import { useState } from 'react'
import { Tip } from './ui'

export default function Page() {
  const [n] = useState(0)
  return <Tip content={<b>{n}</b>}>body</Tip>
}
