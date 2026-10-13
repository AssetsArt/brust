// Passes the props on to another component: the handler would need a binding there.
import Btn from './Btn'
export default function Onward(props: any) {
  return <Btn {...props} />
}
