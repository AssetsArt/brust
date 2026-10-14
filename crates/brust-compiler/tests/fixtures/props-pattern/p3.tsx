export default function C({ onPick = () => 1, label = 'x' }: { onPick?: () => number; label?: string }) {
  return <button onClick={() => onPick()}>{label}</button>
}
