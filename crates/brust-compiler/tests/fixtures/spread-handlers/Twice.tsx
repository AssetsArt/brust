// Spreads the rest onto two elements: React binds the handler on both.
export default function Twice({ label, ...rest }: any) {
  return <p><button {...rest}>{label}</button><a {...rest}>{label}</a></p>
}
