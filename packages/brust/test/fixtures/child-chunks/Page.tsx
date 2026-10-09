// Toggle twice (one link), Static (no chunk ⇒ no link), Counted (useId ⇒ an instances[] record)
// whose grandchild Deep is also reached through Toggle (one link).
import Counted from './Counted'
import Static from './Static'
import Toggle from './Toggle'

export default function Page() {
  return (
    <section>
      <Toggle />
      <Static />
      <Toggle />
      <Counted />
    </section>
  )
}
