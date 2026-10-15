const icons = { home: <b>hi</b> }
const { home } = icons
function pick() {
  return home
}

export default function Page() {
  return <section>{pick()}</section>
}
