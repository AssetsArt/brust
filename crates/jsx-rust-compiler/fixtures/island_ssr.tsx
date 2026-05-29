export default function Page({ data }) {
  return (
    <div>
      <h1>Shell</h1>
      <Island component={Counter} props={data.counter} ssr />
    </div>
  )
}
