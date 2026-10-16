import { createContext, useContext } from 'react'

// the context's default is an object: its Provider's `value` must be an object literal (a variable is not read)
const Ctx = createContext({ n: 0 })

function Box({ n, children }: { n: number; children?: React.ReactNode }) {
  const v = { n }
  return (
    <Ctx.Provider value={v}>
      <div>{children}</div>
    </Ctx.Provider>
  )
}

function Leaf() {
  const c = useContext(Ctx)
  return <b>{c.n}</b>
}

export default function Page() {
  return (
    <Box n={1}>
      <Leaf />
    </Box>
  )
}
