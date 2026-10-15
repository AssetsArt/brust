import * as React from 'react'
const SIZES = ['a', 'b']
// A local alias of React's forwardRef is not resolved by symbol: no exemption.
const fr = React.forwardRef
export const Sized = fr<HTMLElement, object>(function Sized() {
  return <i>{SIZES.join(',')}</i>
})
function get() {
  return SIZES.join(',')
}
export default function Page() {
  return <section>{get()}</section>
}
