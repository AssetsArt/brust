import { Card } from './ui'

const many = Array.from({ length: 5000 }).map((_, i) => `item number ${i} of the long list`)

export default function Page() {
  return (
    <Card title="a">
      {many.map((s) => (
        <p key={s} className="row">
          {s}
        </p>
      ))}
    </Card>
  )
}
