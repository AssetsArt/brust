export default function Thumb({ on }: { on: boolean }) {
  return <i data-testid="thumb" data-state={on ? 'checked' : 'unchecked'} />
}
