// A page that writes its own generator meta: brust must add none (React hoists it into the head).
export default function Own() {
  return (
    <main data-page="own">
      <meta name="generator" content="my-own-tool/1" />
      <h1>own</h1>
    </main>
  )
}
