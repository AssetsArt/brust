import { useQ } from './useQ'

// F578 review: the click runs the hook's returned function, which reads hook-scoped names the chunk must declare.
export default function Finder() {
  const q = useQ()
  return (
    <div>
      <button id="go" onClick={q.find}>
        find
      </button>
      <p id="out">{q.hit}</p>
    </div>
  )
}
