import { createContext, useContext } from 'react'

const Ctx = createContext(0)

function Box({ n, children }: { n: number; children?: React.ReactNode }) {
  return (
    <Ctx.Provider value={n}>
      <div>{children}</div>
    </Ctx.Provider>
  )
}

function Leaf() {
  const n = useContext(Ctx)
  return <b>{n}</b>
}

export default function Page() {
  return (
    <Box n={1}>
      <Leaf />
    </Box>
  )
}
