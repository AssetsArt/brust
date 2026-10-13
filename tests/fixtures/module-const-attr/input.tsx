const LABEL = 'Save "now"'
const COUNT = 3
const LIMIT = COUNT * 2 + 1

export default function Page() {
  return (
    <button title={LABEL} data-limit={LIMIT}>
      {LABEL}
    </button>
  )
}
