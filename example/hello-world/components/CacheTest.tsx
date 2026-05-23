let renderCount = 0

export default function CacheTest() {
  renderCount += 1
  return (
    <>
      <h1>CacheTest</h1>
      <p>{`render=${renderCount}`}</p>
    </>
  )
}
