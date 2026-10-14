import { Card } from './ui'

export default function Page() {
  return (
    <Card title="a">
      <button type="button" onClick={() => console.log('x')}>
        go
      </button>
    </Card>
  )
}
