let renderCount = 0

export default function CacheParamTest() {
  renderCount += 1
  return (
    <>
      <h1>CacheParamTest</h1>
      <p>{`render=${renderCount}`}</p>
    </>
  )
}
