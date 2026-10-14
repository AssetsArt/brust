// As Fusing, with the rest of its props spread into the child (R34.83 + R34.96: PaginationNext over PaginationLink).
import Cell from '../per-instance-jobs/Cell'
import { label } from '../per-instance-jobs/label'
export default function FusingSpread({ x, ...props }: any) {
  return <Cell tone={label(x)} {...props}>w</Cell>
}
