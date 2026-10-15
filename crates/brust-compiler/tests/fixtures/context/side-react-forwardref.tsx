import * as React from 'react'
import { memo } from 'react'
const SIZES = ['a', 'b']
// React's forwardRef / memo store the function they are handed and never call it at load time.
export const Sized = React.forwardRef<HTMLElement, object>(function Sized(_p, _ref) {
  return <i>{SIZES.join(',')}</i>
})
export const Plain = memo(() => <b>{SIZES[0]}</b>)
function get() {
  return SIZES.join(',')
}
export default function Page() {
  return <section>{get()}</section>
}
