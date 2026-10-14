import { createContext, useContext } from 'react'

const Ctx = createContext<{ n: number } | null>(null)

function Box({ n, children }: { n: number; children?: React.ReactNode }) {
  return (
    <Ctx.Provider value={{ n }}>
      <div>{children}</div>
    </Ctx.Provider>
  )
}

function Leaf() {
  const c = useContext(Ctx)
  return <b>{JSON.stringify(c)}</b>
}

export default function Page() {
  return (
    <Box n={1}>
      <Leaf />
    </Box>
  )
}
