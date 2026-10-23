export default function Label({ text }: { text: { a: string } }) {
  return <b data-testid="label">{text.a}</b>
}
