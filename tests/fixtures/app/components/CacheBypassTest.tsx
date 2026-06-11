let renderCount = 0

export default function CacheBypassTest() {
  renderCount += 1
  return (
    <>
      <h1>CacheBypassTest</h1>
      <p>{`render=${renderCount}`}</p>
    </>
  )
}
