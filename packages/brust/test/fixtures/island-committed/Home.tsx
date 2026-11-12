import Counter from './Counter'
import Width from './Width'

export default function Home() {
  return (
    <main>
      <h1>committed</h1>
      <Counter start={2} />
      <Width />
    </main>
  )
}
