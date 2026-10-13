import { Card } from './ui'

const extra = { id: 'z' }

export default function Page() {
  return (
    <Card title="a">
      <p {...extra}>x</p>
    </Card>
  )
}
