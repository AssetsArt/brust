// Spreads the rest and also reads a key by name.
export default function Reads(props: any) {
  return <button {...props}>{props['aria-pressed'] ? 'on' : 'off'}</button>
}
