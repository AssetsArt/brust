import { Card } from './ui'

export default function Page({ show }: { show: boolean }) {
  return <Card title="a">{show && <b>x</b>}</Card>
}
