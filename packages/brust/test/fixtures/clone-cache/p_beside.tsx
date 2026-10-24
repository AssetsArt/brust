import { Beside, Both } from './ctx'
// F372 R1: the content sits beside Frame inside Beside: it reads the default K; Beside stays an island.
export default function Page() {
  return (
    <main>
      <Beside id="1">
        <Both label="AAA" />
      </Beside>
    </main>
  )
}
