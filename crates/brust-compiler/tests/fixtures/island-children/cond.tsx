import { Card } from './ui'

const on = true

export default function Page() {
  return <Card title="a">{on ? <b>x</b> : null}</Card>
}
