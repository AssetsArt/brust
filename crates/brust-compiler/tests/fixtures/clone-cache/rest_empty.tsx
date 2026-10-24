import { Outer } from './ctx'
// F375: a rest forwarder into a native Provider called with no children (and no spread): the Provider is specialised
// with none (#345 made this an island).
export default function Page() {
  return (
    <main>
      <Outer />
    </main>
  )
}
