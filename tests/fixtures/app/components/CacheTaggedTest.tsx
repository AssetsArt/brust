let renderCount = 0

// Module-level counter (own counter, isolated from the other cache fixtures) so
// a fresh render is observably different from a cached HIT (which freezes the
// rendered body). Used by the L1 tag-invalidation integration test.
export default function CacheTaggedTest() {
  renderCount += 1
  return (
    <>
      <h1>CacheTaggedTest</h1>
      <p>{`render=${renderCount}`}</p>
    </>
  )
}
