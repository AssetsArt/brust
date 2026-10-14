import { Badge, Card, Tip } from './ui'

export default function Page() {
  return (
    <Card title="outer">
      <Tip content={<Badge n={7} />}>inner</Tip>
    </Card>
  )
}
