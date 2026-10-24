import { Outer } from './ctx'
// F375 (b): the wrapper called with no children, no spread: Prov is specialised with none (was an island since #345).
export default function Page() {
  return (
    <main>
      <Outer id="1" />
    </main>
  )
}
