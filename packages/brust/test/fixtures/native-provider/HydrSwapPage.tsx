import HydrLog from './HydrLog'

// F302: one instance per page; the test moves the server markup of a second page in after the first booted.
export default function HydrSwapPage({ name }: { name: string }) {
  return (
    <main>
      <HydrLog name={name} />
    </main>
  )
}
