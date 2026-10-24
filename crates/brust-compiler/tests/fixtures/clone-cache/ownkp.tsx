import { KP, OnlyK, Prov } from './ctx'
// F372: the content's OWN K Provider (KP) is nearer than Frame inside Prov: React reads KP's value (7). (A consumer that also
// reads Prov's On from inside KP's content is A1's refusal, unchanged.)
export default function Page() {
  return (
    <main>
      <Prov>
        <KP v={7}>
          <OnlyK label="AAA" />
        </KP>
      </Prov>
    </main>
  )
}
