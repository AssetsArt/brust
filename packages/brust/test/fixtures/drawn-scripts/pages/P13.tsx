import Busy from '../Busy'
import Caller from '../Caller'
import Doc from '../Doc'
import Tidy from '../Tidy'

export default function P13({ kind }: { kind: string }) {
  return (
    <Doc title="13">
      {kind === 'busy' ? <Busy /> : null}
      {kind === 'tidy' ? <Tidy /> : null}
      {kind === 'caller' ? <Caller /> : null}
    </Doc>
  )
}
