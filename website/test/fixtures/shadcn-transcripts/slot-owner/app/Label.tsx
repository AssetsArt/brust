// A static child: no host of its own unless a call site links it.
export default function Label({ on, children }: { on: boolean; children?: React.ReactNode }) {
  return <span data-on={on ? 'yes' : 'no'}>{children}</span>
}
