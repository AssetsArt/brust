import { Card } from './ui'

export default function Page({ on }: { on: boolean }) {
  return <Card title="a">{on ? <b>x</b> : null}</Card>
}
