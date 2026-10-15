import React from 'react'
const SIZES = ['a', 'b']
// React's memo through a default import: stored, called only at render.
export const Plain = React.memo(function Plain() {
  return <b>{SIZES[0]}</b>
})
function get() {
  return SIZES.join(',')
}
export default function Page() {
  return <section>{get()}</section>
}
