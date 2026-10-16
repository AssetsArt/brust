// Leaves the source root: `../secret/Secret` is not under `../shared`.
import Secret from '../secret/Secret'

export default function Leak() {
  return <p><Secret /></p>
}
