let renderCount = 0

export default function CachePrefixTest() {
  renderCount += 1
  return (
    <>
      <h1>CachePrefixTest</h1>
      <p>{`render=${renderCount}`}</p>
    </>
  )
}
