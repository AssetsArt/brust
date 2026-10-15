import { Disclosure, DisclosureContent, DisclosureTrigger } from './Disclosure'

// Two instances that each carry a `useId`, nested: the server cannot feed an id through another fed component, so this
// call site keeps the island Provider (with its children), as before.
export default function NestedIds() {
  return (
    <main>
      <Disclosure defaultOpen={true}>
        <DisclosureTrigger>Outer</DisclosureTrigger>
        <DisclosureContent>
          <Disclosure defaultOpen={false}>
            <DisclosureTrigger>Inner</DisclosureTrigger>
            <DisclosureContent>
              <p>inner body</p>
            </DisclosureContent>
          </Disclosure>
        </DisclosureContent>
      </Disclosure>
    </main>
  )
}
