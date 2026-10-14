import { Card } from './ui'

export default function Page({ xs }: { xs: string[] }) {
  return <Card title="a">{xs.map((x) => <i key={x}>{x}</i>)}</Card>
}
