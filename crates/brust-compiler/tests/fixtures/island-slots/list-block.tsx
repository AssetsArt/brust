import { Card } from './ui'

const rows = [1, 2].map((n) => {
  return n + 1
})

export default function Page() {
  return (
    <Card title="a">
      {rows.map((r) => (
        <i key={r}>{r}</i>
      ))}
    </Card>
  )
}
