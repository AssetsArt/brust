const STAMP = Date.now()
const SORTED = [3, 1, 2].slice()

export default function Page() {
  return (
    <p>
      {STAMP} {SORTED.length}
    </p>
  )
}
