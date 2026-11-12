// form-action: 'self' (here, the actions prefix) is allowed; another origin is not unless listed.
export default function Forms() {
  return (
    <main>
      <h1>gaps forms</h1>
      <form id="own" method="post" action="/shop/rpc/form">
        <button type="submit" id="own-submit">own</button>
      </form>
      <form id="other" method="post" action="https://elsewhere.example/collect">
        <button type="submit" id="other-submit">other</button>
      </form>
    </main>
  )
}
