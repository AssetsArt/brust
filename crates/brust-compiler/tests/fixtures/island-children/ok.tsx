import { Badge, Card, Wrap } from './ui'

export default function Page() {
  return (
    <main>
      <Card title="a">
        <p className="x">
          hi <b>there</b>
        </p>
        <Badge n={1} tone="loud" />
        <Wrap label="w" />
      </Card>
      <Card title="b">just text</Card>
      <Card title="c">
        <>
          <hr />
          <input disabled defaultValue="v" />
        </>
      </Card>
    </main>
  )
}
