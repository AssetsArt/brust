import Control from './Control'

export default function Page() {
  return (
    <main>
      <form data-testid="form">
        <Control id="in" />
      </form>
      <Control id="out" />
      <Control id="named" form="elsewhere" />
    </main>
  )
}
