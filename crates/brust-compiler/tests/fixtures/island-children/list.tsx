import { Card } from './ui'

export default function Page({ xs }: { xs: string[] }) {
  return (
    <Card title="a">
      <ul>
        {xs.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
    </Card>
  )
}
