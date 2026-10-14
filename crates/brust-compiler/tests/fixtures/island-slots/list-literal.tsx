import { Card } from './ui'

export default function Page() {
  return (
    <Card title="a">
      <ul>
        {[1, 2, 3].map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </Card>
  )
}
