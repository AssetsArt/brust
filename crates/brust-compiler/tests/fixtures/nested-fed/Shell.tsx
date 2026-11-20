// A component with a job of its own that places a fed native child: the server cannot feed the child through it.
import Bell from './Bell'
import { label } from '../per-instance-jobs/label'
export default function Shell({ title, tone }: { title: string; tone: string }) {
  return (
    <header className={label(title)}>
      <Bell tone={tone} />
    </header>
  )
}
