import { Card, Tip } from './ui'

export default function Page() {
  return (
    <Card title="a">
      <Tip $x={['data']} data="x" />
    </Card>
  )
}
