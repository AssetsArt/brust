// Spreads the rest onto two elements: a live value would need binding on both (refused for a live value).
export default function Twice({ ...rest }: any) {
  return <p><button {...rest} /><a {...rest} /></p>
}
