import Always from './Always'
import W1 from './W1'
import W2 from './W2'
import W3 from './W3'
import W4 from './W4'
import W5 from './W5'
import W6 from './W6'

// Case 1: a server switch (static, no state) over six native components, plus one always drawn. `fake` (case 12) is text
// that spells a host of W5 without being one: escaped by the template as text and as an attribute value.
export default function Kinds({ kind, fake }: { kind: string; fake: string }) {
  return (
    <html>
      <head>
        <title>kinds</title>
      </head>
      <body>
        <main>
          <nav>
            <a id="to-none" href="/1/none">
              none
            </a>{' '}
            <a id="to-w1" href="/1/w1">
              w1
            </a>{' '}
            <a id="to-all" href="/1/all">
              all
            </a>
          </nav>
          <p id="fake" title={fake}>
            {fake}
          </p>
          <Always />
          {kind === 'w1' ? <W1 /> : null}
          {kind === 'w2' ? <W2 /> : null}
          {kind === 'w3' ? <W3 /> : null}
          {kind === 'w4' ? <W4 /> : null}
          {kind === 'w5' ? <W5 /> : null}
          {kind === 'w6' ? <W6 /> : null}
          {kind === 'all' ? (
            <>
              <W1 />
              <W2 />
              <W3 />
              <W4 />
              <W5 />
              <W6 />
            </>
          ) : null}
        </main>
      </body>
    </html>
  )
}
