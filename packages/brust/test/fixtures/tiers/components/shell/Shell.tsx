// A component with a job of its own that places a fed native child: the child is its React copy there (F560).
import { label } from '../../lib/label'
import Bell from './Bell'

export default function Shell({ title, tone }: { title: string; tone: string }) {
  return (
    <header className={label(title)}>
      <Bell tone={tone} />
    </header>
  )
}
