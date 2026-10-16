import { createElement } from 'react'
import { cases } from './cases'
import Fwd from './Fwd'
import ClsOwn from './ClsOwn'
import FwdOwn from './FwdOwn'

const server = (await import('react-dom/server')) as unknown as { renderToStaticMarkup(el: unknown): string }

/** React's own render of the same elements (`Page` has its state; this takes it as an argument), one `<div data-case>` each. */
export function renderCases(on: boolean): string {
  return server.renderToStaticMarkup(
    createElement(
      'main',
      null,
      ...cases(on).map(({ own, props }, i) =>
        createElement({ none: Fwd, style: FwdOwn, class: ClsOwn }[own], { 'data-case': String(i), ...props }),
      ),
    ),
  )
}
