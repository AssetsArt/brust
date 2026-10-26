// A same-origin form: the page and the action are on one origin, so the post is admitted.
export default function Home() {
  return (
    <form method="post" action="/auth/form">
      <input name="text" defaultValue="same-origin" />
      <button type="submit">save</button>
    </form>
  )
}
