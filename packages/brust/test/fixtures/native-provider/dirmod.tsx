import * as React from 'react'

// Radix's `react-direction` as published: the context is the module's own, only the Provider and the hook leave it
const Direction = {
  LTR: 'ltr',
  RTL: 'rtl',
} as const

type Direction = (typeof Direction)[keyof typeof Direction]

const DirectionContext = React.createContext<Direction | undefined>(undefined)

// (Radix writes it as an arrow const typed `React.FC`; a function declaration here until arrow-const components compile)
export function DirectionProvider({ dir, children }: { children?: React.ReactNode; dir: Direction }) {
  return <DirectionContext.Provider value={dir}>{children}</DirectionContext.Provider>
}

export function useDirection(localDir?: Direction) {
  const globalDir = React.useContext(DirectionContext)
  return localDir || globalDir || Direction.LTR
}
