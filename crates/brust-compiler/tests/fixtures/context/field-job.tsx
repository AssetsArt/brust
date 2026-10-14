import { createContext, useContext } from 'react'

const Ctx = createContext<Record<string, string> | null>(null)

function Box({ t, children }: { t: string; children?: React.ReactNode }) {
  return (
    <Ctx.Provider value={{ 'x-y': t, ok: t }}>
      <div>{children}</div>
    </Ctx.Provider>
  )
}

function Leaf() {
  const { 'x-y': v } = useContext(Ctx)!
  return <b>{v}</b>
}

export default function Page() {
  return (
    <Box t="x">
      <Leaf />
    </Box>
  )
}
