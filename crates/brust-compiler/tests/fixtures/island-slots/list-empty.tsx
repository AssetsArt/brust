import { Card } from './ui'

const none: string[] = []

export default function Page() {
  return (
    <Card title="a">
      {none.map((x) => (
        <i key={x}>{x}</i>
      ))}
    </Card>
  )
}
