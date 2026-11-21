// F604: echoes the request's marker so a test can pair every response with its request.
export default function Page({ m }: { m: string }) {
  return <p id="m">{m}</p>
}
