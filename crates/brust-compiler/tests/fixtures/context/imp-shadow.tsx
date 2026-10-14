import { el } from './lib/els'

void el

// A prop named like the imported JSX const shadows it: the child is the prop, which lowers.
function Show({ el }: { el?: string }) {
  return <p>{el}</p>
}

export default function Page() {
  return <Show el="mine" />
}
