// Spreads its own props into a fed child (F164): the job's input `tone` can ride the spread.
import Cell from '../per-instance-jobs/Cell'
export default function SpreadWrapper({ className, ...props }: any) {
  return <Cell {...props}>x</Cell>
}
