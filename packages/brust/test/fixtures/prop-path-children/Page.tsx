import Frame from './Frame'
import { Body, Disclosure, Trigger } from './ui'

// A route component: its props are request data (the loader). Strings fill the holes; the object `hostile` is never walked.
export default function Page({ title, hostile }: { title: string; hostile: string }) {
  return (
    <main>
      <h1>prop-path children</h1>
      <Frame label="one" note={title} shown>
        <b data-testid="inner-one">inner one</b>
      </Frame>
      <Frame label="two" note={hostile} />
      <Disclosure label="root">
        <Trigger>Toggle root</Trigger>
        <Body>
          <span data-testid="root-note" title={title}>
            {hostile}
          </span>
          <i data-testid="root-title">{title}</i>
        </Body>
      </Disclosure>
    </main>
  )
}
