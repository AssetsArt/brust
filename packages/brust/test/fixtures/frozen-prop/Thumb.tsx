export default function Thumb({ on }: { on: boolean }) {
  return <i data-state={on ? 'checked' : 'unchecked'} />
}
