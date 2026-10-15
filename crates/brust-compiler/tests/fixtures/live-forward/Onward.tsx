// Passes the rest on to another component.
import Btn from './Btn'
export default function Onward({ ...rest }: any) {
  return <Btn {...rest} />
}
