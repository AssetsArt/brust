import { Card } from './ui'

const many = Array.from({ length: 20000 }).map((_, i) => i)

export default function Page() {
  return (
    <Card title="a">
      {many.map((n) => (
        <i key={n}>{n}</i>
      ))}
    </Card>
  )
}
