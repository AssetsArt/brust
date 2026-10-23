import face from './fonts/face.woff2'

// Static page: the URL is a module constant.
export default function Plain() {
  return <p id="plain" data-face={face}>plain</p>
}
