import { Beside, Both } from './ctx'
// F372 R1: the content sits beside Frame in Beside, so it reads the call site's K (none: the default 0), not Frame's.
export default function Page() {
  return (
    <main>
      <Beside>
        <Both label="AAA" />
      </Beside>
    </main>
  )
}
