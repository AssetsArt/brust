import Doc from '../Doc'
import W5 from '../W5'

// Case 12: raw HTML (not escaped) that spells W5's host: the scan keeps W5's chunk (a false keep, allowed), while the
// route itself never draws W5 (`show` is false).
export default function P12({ raw, show }: { raw: string; show: boolean }) {
  return (
    <Doc title="12">
      <div id="raw" dangerouslySetInnerHTML={{ __html: raw }} />
      {show ? <W5 /> : null}
    </Doc>
  )
}
