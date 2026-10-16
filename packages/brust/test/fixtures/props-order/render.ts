import { createElement } from 'react'
import IslandBox from './IslandBox'

const server = (await import('react-dom/server')) as unknown as { renderToStaticMarkup(el: unknown): string }

/** React's own render of the island with the props `Page.tsx` writes. */
export const renderBox = (): string =>
  server.renderToStaticMarkup(
    createElement(IslandBox, { style: { marginTop: 5, margin: 0, color: 'red' }, cfg: { z: 1, a: { y: 2, b: 3 }, m: [{ q: 1, c: 2 }] } }),
  )
