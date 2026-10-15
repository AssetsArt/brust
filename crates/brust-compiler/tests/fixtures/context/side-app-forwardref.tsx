import { forwardRef } from './lib/react-reexport'
const SIZES = ['a', 'b']
export const Sized = forwardRef<HTMLElement, object>(function Sized() {
  return <i>{SIZES.join(',')}</i>
})
function get() {
  return SIZES.join(',')
}
export default function Page() {
  return <section>{get()}</section>
}
