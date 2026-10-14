import { createContext, useContext } from 'react'

const Ctx = createContext<{ label: string } | null>(null)

function Box({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <Ctx.Provider value={{ label }}>
      <div>{children}</div>
    </Ctx.Provider>
  )
}

function Leaf() {
  const c = useContext(Ctx)!
  return <b>{c.label}</b>
}

// A wrapper around a consumer: the need bubbles up to the page that renders it inside the Box.
function Wrapped() {
  return <Leaf />
}

export default function Page() {
  return (
    <Box label="L">
      <Wrapped />
    </Box>
  )
}
