// Test fixture for native-render T9 ssr renderToString. A trivial island whose
// markup embeds its `n` prop, so a test can assert (a) it server-renders to
// `<span>N</span>` and (b) the value it received matches the roundtripped
// `_props`. createElement (no JSX) keeps the fixture transpile-trivial.
import { createElement } from 'react'

export default ({ n }: { n: number }) => createElement('span', null, String(n))
