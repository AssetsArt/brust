function Card() {
  return <i />
}
Card.displayName = 'Card'
function label() {
  return Card.displayName
}

export default function Page() {
  return <section>{label()}</section>
}
