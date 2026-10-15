// Passes its own rest on to the toggle: the call sites of Wrap inherit the toggle's requirement.
import Toggle2 from './Toggle2'
export default function Wrap({ label, ...rest }: any) {
  return <div><Toggle2 {...rest} /><i>{label}</i></div>
}
