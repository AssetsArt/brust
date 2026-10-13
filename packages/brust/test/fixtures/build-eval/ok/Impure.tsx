function stamp(): number {
  return Date.now()
}
function roll(): number {
  return Math.random()
}

export default function Impure() {
  return (
    <p>
      <span id="a">{stamp() > 0 ? 'time' : 'never'}</span>
      <span id="b">{roll() >= 0 ? 'rand' : 'never'}</span>
    </p>
  )
}
