import { Badge, Card } from './ui'

const groups = [
  { name: 'a', items: [1, 2] },
  { name: 'b', items: [] },
  { name: 'c', items: [3] },
]

export default function Page() {
  return (
    <Card title="g">
      {groups.map((g) => (
        <section key={g.name}>
          <h3>{g.name}</h3>
          {g.items.map((n) => (
            <Badge key={n} n={n * 2} tone={g.name} />
          ))}
        </section>
      ))}
    </Card>
  )
}
