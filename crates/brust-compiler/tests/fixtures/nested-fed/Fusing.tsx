// A static wrapper with a job of its own whose child's prop is that job's output (shadcn PaginationNext shape).
import Cell from '../per-instance-jobs/Cell'
import { label } from '../per-instance-jobs/label'
export default function Fusing({ x }: any) {
  return <Cell tone={label(x)}>w</Cell>
}
