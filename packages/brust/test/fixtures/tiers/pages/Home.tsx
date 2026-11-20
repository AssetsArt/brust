import Card from '../components/views/Card'
import Counter from '../components/views/Counter'
import { Badge } from '../components/views/Badge'
import Wide from '../components/widgets/Wide'

export default function Home() {
  return (
    <main>
      <Card title="hello" />
      <Badge text="new" />
      <Counter />
      <Wide />
    </main>
  )
}
