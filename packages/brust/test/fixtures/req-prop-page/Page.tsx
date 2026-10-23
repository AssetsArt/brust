import { Count } from './components/Count'

// A route page: `req` here is what the router hands the page, so it is request state wherever it flows.
export default function Page({ req }: { req: string }) {
  return (
    <main>
      <Count req={req} />
    </main>
  )
}
