import { createElement } from 'react'
import About from './About'
import Home from './Home'
import Plain from './Plain'

/** The React reference: the layout's document around each page, by route name. */
const Doc = ({ page }: { page: () => ReturnType<typeof Home> }) => (
  <html lang="en">
    <head>
      <meta charSet="utf-8" />
      <title>Site</title>
    </head>
    <body>{createElement(page)}</body>
  </html>
)
export const pages: Record<string, unknown> = { home: () => <Doc page={Home} />, about: () => <Doc page={About} />, plain: () => <Doc page={Plain} /> }
