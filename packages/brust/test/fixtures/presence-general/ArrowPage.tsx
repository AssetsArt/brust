import { Counter, Root } from './Arrow'

export default function ArrowPage() {
  return (
    <main>
      <Counter start={2} label="named" />
      <Root start={5} label="alias" />
    </main>
  )
}
