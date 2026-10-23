// A native component (state + handler): the imported URL is a build-time string in its markup.
import { useState } from 'react'
import mark from './fonts/mark.png'
import face from './fonts/face.woff2'

export default function Native() {
  const [n, setN] = useState(0)
  return (
    <main>
      <img id="mark" src={mark} alt="" />
      <button id="btn" data-face={face} onClick={() => setN(n + 1)}>
        {n}
      </button>
    </main>
  )
}
