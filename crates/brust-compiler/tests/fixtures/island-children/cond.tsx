import { Card } from './ui'

export default function Page({ on }: { on: boolean }) {
  return <Card title="a">{on === true ? <b>x</b> : null}</Card>
}
