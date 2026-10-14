import { createContext, useContext } from 'react'

const Ctx = createContext<Record<string, string> | null>(null)

function Box({ t, children }: { t: string; children?: React.ReactNode }) {
  return (
    <Ctx.Provider value={{ ok: t }}>
      <div>{children}</div>
    </Ctx.Provider>
  )
}

function Leaf() {
  const { ok } = useContext(Ctx)!
  return <b>{ok}</b>
}

export default function Page() {
  return (
    <Box t="x">
      <Leaf />
    </Box>
  )
}
