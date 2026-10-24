import { KP, OnlyK, Prov } from './ctx'
// F372: the content's own K Provider (KP) is nearer than Frame inside Prov: the consumer reads KP's value.
export default function Page() {
  return (
    <main>
      <Prov id="1">
        <KP id="1" v={7}>
          <OnlyK label="AAA" />
        </KP>
      </Prov>
    </main>
  )
}
