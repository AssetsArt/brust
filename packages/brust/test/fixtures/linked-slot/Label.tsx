export default function Label({ on, children }: { on: boolean; children?: React.ReactNode }) {
  return <span data-testid="label" data-on={on ? 'yes' : 'no'}>{children}</span>
}
