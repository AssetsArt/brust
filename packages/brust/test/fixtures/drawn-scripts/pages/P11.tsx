import Doc from '../Doc'
import SiteA from '../SiteA'
import SiteB from '../SiteB'

export default function P11({ kind }: { kind: string }) {
  return (
    <Doc title="11">
      {kind === 'a' || kind === 'ab' ? <SiteA /> : null}
      {kind === 'b' || kind === 'ab' ? <SiteB /> : null}
    </Doc>
  )
}
