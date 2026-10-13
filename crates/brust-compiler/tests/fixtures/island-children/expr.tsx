import { Card } from './ui'

export default function Page({ name }: { name: string }) {
  return <Card title="a">hello {name}</Card>
}
