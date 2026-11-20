// Shell with another reason to need React (a hook brust does not lower): the child's React copy would change nothing.
import { useSyncExternalStore } from 'react'
import Bell from './Bell'
import { label } from '../per-instance-jobs/label'
export default function ShellHook({ title, tone }: { title: string; tone: string }) {
  const n = useSyncExternalStore(
    () => () => {},
    () => 1,
    () => 1,
  )
  return (
    <header className={label(title)} data-n={n}>
      <Bell tone={tone} />
    </header>
  )
}
