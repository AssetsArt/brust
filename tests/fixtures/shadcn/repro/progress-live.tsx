import { useState } from 'react'
import { Progress } from '../components/ui/progress'

// Condition 2 (progress-flip): the value the Radix Root derives its aria/data attributes from follows the page's state.
export default function Page() {
  const [v, setV] = useState(13)
  return (
    <div>
      <Progress value={v} className="w-[60%]" />
      <button onClick={() => setV(v === 13 ? 66 : v === 66 ? 100 : 13)}>go</button>
    </div>
  )
}
