import Board from '../Board'
import Doc from '../Doc'

export default function P4({ full }: { full: boolean }) {
  return (
    <Doc title="4">
      <Board initial={full ? [{ id: 'z', label: 'Z' }] : []} />
    </Doc>
  )
}
