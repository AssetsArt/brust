import { useState } from 'react'

// dangerouslySetInnerHTML driven by state: x-html swaps the markup on click.
export default function InnerHtml() {
  const [on, setOn] = useState(true)
  return (
    <div>
      <button onClick={() => setOn(!on)}>swap</button>
      <p id="out" dangerouslySetInnerHTML={{ __html: on ? '<b>bold</b>' : '<i>ital</i>' }} />
    </div>
  )
}
