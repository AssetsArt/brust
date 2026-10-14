// A static wrapper around a fed child (a job input read from its own prop): shadcn's PaginationNext shape.
import Cell from '../per-instance-jobs/Cell'
export default function Wrapper({ tone }: any) {
  return <Cell tone={tone}>x</Cell>
}
