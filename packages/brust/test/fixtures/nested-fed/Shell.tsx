// F560: a component with a job of its own that places Bell: the server cannot feed Bell through it, so Bell is its React
// copy here and Shell keeps its tier.
import Bell from './Bell'
import { label } from './label'
export default function Shell({ title, tone }: { title: string; tone: string }) {
  return (
    <header className={label(title)}>
      <b>{title}</b>
      <Bell tone={tone} />
    </header>
  )
}
