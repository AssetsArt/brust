// The closing band: the call to action and the version seal.
import Button from '../Button'

export default function Closing({ major, label }: { major: string; label: string }) {
  return (
    <section className="closing">
      <div className="wrap">
        <div>
          <h2>Read the quickstart, then ship something small.</h2>
        </div>
        <div className="seal" aria-hidden="true">
          <span>brust</span>
          <b>v{major}</b>
          <span>{label}</span>
        </div>
        <div className="cta">
          <Button href="/docs/quickstart" label="Open the docs" primary />
          <Button href="https://github.com/AssetsArt/brust/tree/v2/examples/pokedex" label="See the pokedex example" />
        </div>
      </div>
    </section>
  )
}
