// Regression fixture for the cache status gate: the FIRST render throws (→ a
// framed 500 through the same single-chunk path as a success), every later
// render succeeds. If the cache ever writes back a non-200, request #2 would
// replay the cached 500 instead of rendering fresh.
let attempts = 0

export default function CacheFlakyTest() {
  attempts += 1
  if (attempts === 1) throw new Error('flaky first render (intentional)')
  return (
    <>
      <h1>CacheFlakyTest</h1>
      <p>{`render=${attempts}`}</p>
    </>
  )
}
