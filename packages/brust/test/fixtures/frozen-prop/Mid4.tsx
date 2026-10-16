import Fwd from './Fwd'
import Thumb from './Thumb'
// A static child (no state, no handler): printed in its caller's scope, so the caller follows the prop for it.
export default function Mid4({ on }: { on: boolean }) {
  return (
    <div data-testid="box">
      {[1, 2].map((i) => <b key={i}>{on ? i : -i}</b>)}
      <Thumb on={on} />
      <Fwd data-x={on ? 'x' : 'y'} />
    </div>
  )
}
