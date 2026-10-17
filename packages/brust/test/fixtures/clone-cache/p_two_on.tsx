import { OnlyOn, Prov } from './ctx'
// F238: two clones of Prov with different content (reading Prov's own context); inside each, Frame is specialised with that clone's content.
export default function Page() {
  return (
    <main>
      <Prov id="1">
        <OnlyOn label="AAA" />
      </Prov>
      <Prov id="2">
        <OnlyOn label="BBB" />
      </Prov>
    </main>
  )
}
