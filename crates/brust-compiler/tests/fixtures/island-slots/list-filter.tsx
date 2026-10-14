import { Card } from './ui'

const rows = ['a', 'bb', 'ccc']

export default function Page() {
  return (
    <Card title="a">
      {rows.filter((r) => r.length > 1).map((r) => (
        <i key={r}>{r}</i>
      ))}
    </Card>
  )
}
