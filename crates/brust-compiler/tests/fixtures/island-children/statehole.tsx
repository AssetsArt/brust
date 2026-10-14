import { useState } from 'react'
import { Card } from './ui'

export default function Page({ title }: { title: string }) {
  const [n] = useState(0)
  return (
    <Card title="a">
      <b title={title}>{n}</b>
    </Card>
  )
}
