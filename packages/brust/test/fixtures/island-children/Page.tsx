import { Body, Disclosure, Label, Plain, Trigger } from './ui'

// The page has no state: it stays static. Each <Disclosure> is an island that receives its children as JSON.
export default function Page() {
  return (
    <main>
      <h1>island children</h1>
      <Disclosure label="one">
        <Trigger>Toggle one</Trigger>
        <Body>
          <Plain>
            Secret <b>one</b> <Label text="tagged" />
          </Plain>
        </Body>
      </Disclosure>
      <Disclosure label="two">
        <Trigger asChild>
          <button type="button" className="as-child" data-testid="trigger-two">
            Toggle two
          </button>
        </Trigger>
        <Body>Secret two{' "q" \'a\' </script><b>x</b> & done'}</Body>
      </Disclosure>
    </main>
  )
}
