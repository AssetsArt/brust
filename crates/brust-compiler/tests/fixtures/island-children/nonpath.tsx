import { Card } from './ui'

export default function Page({ a, b }: { a?: string; b?: string }) {
  return <Card title={a ?? b}>x</Card>
}
