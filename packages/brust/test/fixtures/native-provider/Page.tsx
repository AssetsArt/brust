import { Disclosure, DisclosureContent, DisclosureTrigger } from './Disclosure'

export default function Page() {
  return (
    <main>
      {/* defaultOpen is passed here until F234 (an omitted defaulted prop is seeded as null) is fixed */}
      <Disclosure defaultOpen={false}>
        <DisclosureTrigger>First</DisclosureTrigger>
        <DisclosureContent>
          <p>first body</p>
        </DisclosureContent>
      </Disclosure>
      <Disclosure defaultOpen>
        <DisclosureTrigger>Second</DisclosureTrigger>
        <DisclosureContent>
          <p>second body</p>
        </DisclosureContent>
      </Disclosure>
    </main>
  )
}
