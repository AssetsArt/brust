import { Card } from './ui'

const tags = Array.from({ length: 4 }).map((_, i, a) => `v1.2.0-beta.${a.length - i}`)

export default function Page() {
  return (
    <Card title="a">
      {tags.map((tag) => (
        <div key={tag}>{tag}</div>
      ))}
    </Card>
  )
}
