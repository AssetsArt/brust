import { Card } from './ui'

export default function Page({ rows }: { rows: string[] }) {
  return (
    <Card title="a">
      {rows.map((r) => (
        <i key={r}>{r}</i>
      ))}
    </Card>
  )
}
