// Reads window during render ⇒ a client_only React island: the URL string is in its client chunk.
import face from './fonts/face.woff2'

export default function Island() {
  const w = window.innerWidth
  return (
    <p id="island" data-face={face} data-w={w}>
      island
    </p>
  )
}
