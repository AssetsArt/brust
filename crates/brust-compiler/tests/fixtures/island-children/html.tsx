import { Card } from './ui'

export default function Page() {
  return (
    <Card title="a">
      <div dangerouslySetInnerHTML={{ __html: '<b>x</b>' }} />
    </Card>
  )
}
