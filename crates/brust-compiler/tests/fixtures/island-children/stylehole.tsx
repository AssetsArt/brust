import { Card } from './ui'

export default function Page({ look }: { look: Record<string, string> }) {
  return (
    <Card title="a">
      <b style={look}>x</b>
    </Card>
  )
}
