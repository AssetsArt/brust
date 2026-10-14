import { Card } from './ui'

export default function Page() {
  return (
    <Card title="a">
      <ul>
        {['a', 'b'].map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
    </Card>
  )
}
