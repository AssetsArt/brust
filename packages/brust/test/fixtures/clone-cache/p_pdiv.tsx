import { Both, Prov } from './ctx'
// F372: the consumer under a plain element of Prov's content reads Frame's K (the inner Provider).
export default function Page() {
  return (
    <main>
      <Prov id="1">
        <div data-pad="1">
          <Both label="AAA" />
        </div>
      </Prov>
    </main>
  )
}
