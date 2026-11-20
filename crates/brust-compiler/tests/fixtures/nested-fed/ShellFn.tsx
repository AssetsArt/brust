// Shell hands the child a function: as a React island the child cannot take it, so the copy does not help.
import Bell from './BellFn'
import { label } from '../per-instance-jobs/label'
export default function ShellFn({ title, tone }: { title: string; tone: string }) {
  return (
    <header className={label(title)}>
      <Bell tone={tone} format={(s: string) => s + '!'} />
    </header>
  )
}
