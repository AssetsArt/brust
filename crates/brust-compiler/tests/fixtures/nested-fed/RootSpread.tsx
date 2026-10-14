// A route component spreading its (request) props into a fed child.
import Cell from '../per-instance-jobs/Cell'
export default function RootSpread(props: any) {
  return <Cell {...props}>x</Cell>
}
